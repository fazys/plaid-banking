/*
  Bookkeeping tabs in the Google Sheet (turned on with BOOKKEEPING_ENABLED=true):

  1. One statement tab per bank / card account, filled from Plaid, with a block
     per month (current month on top): month heading, column headers, an
     Opening Balance row (last month's closing) and that month's transactions.
     Each row has Concat (date serial & category), Date, Reference, Description,
     Payment, Deposit, Running Balance, Transaction Amount, Category (dropdown), Details.
     Every sync rewrites the rows from Plaid but keeps the Category and Details
     the bookkeeper typed (matched by the hidden Plaid transaction ID).
  2. A "Cash Burn Report" tab with a block per month, current month on top.
     Each block has a row per day with category totals (SUMIF on the statement
     tabs' Concat column), each account's closing balance, the total balance,
     Burn (today's total minus yesterday's) and Variance (category total minus
     Burn; 0 when everything reconciles).
  3. A "Cash Summary" tab with one row per month (current month on top),
     linked to each month's total row in the Cash Burn Report.

  The Cash Burn Report and Cash Summary are all formulas, so changing a category
  in a statement tab updates them right away.
*/

const {
  createGoogleAuth,
  createSheetsClient,
  requireSheetsConfig,
  quoteSheetName,
  columnLetter,
  getZonedDate,
} = require('./sheets');

const CATEGORIES = [
  'Collections',
  'Owners Draws',
  'COS',
  'CAC',
  'Subscriptions',
  'Professional Fee',
  'Office Expenses',
  'Travel',
  'Loans',
  'Bank Charges',
  'Others',
  'Contra',
];

const MAX_REPORT_MONTHS = 24;
const TAB_KEY = 'bookkeepingTab';

const MONEY_FORMAT = { type: 'NUMBER', pattern: '#,##0.00' };
const STATEMENT_DATE_FORMAT = { type: 'DATE', pattern: 'mm/dd/yyyy' };
const REPORT_DATE_FORMAT = { type: 'DATE', pattern: 'm/d/yyyy' };
const HEADER_BACKGROUND = { red: 0.91, green: 0.93, blue: 0.96 };
const HEADER_BLUE = { red: 0.16, green: 0.42, blue: 0.85 };
const BLACK = { red: 0, green: 0, blue: 0 };
const SOLID_BORDER = { style: 'SOLID', color: BLACK };

// Statement tab columns (0-based).
const COL = {
  concat: 0,
  date: 1,
  reference: 2,
  description: 3,
  payment: 4,
  deposit: 5,
  balance: 6,
  amount: 7,
  category: 8,
  details: 9,
  id: 10,
};
const STATEMENT_HEADERS = [
  'Concat',
  'Date',
  'Reference Number',
  'Description',
  'Payment',
  'Deposit',
  'Running Balance',
  'Transaction Amount',
  'Category',
  'Details',
  'Plaid ID (used by the app)',
];

function isBookkeepingEnabled() {
  return String(process.env.BOOKKEEPING_ENABLED || '').toLowerCase() === 'true';
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

// Google Sheets stores dates as days since 1899-12-30.
function dateSerial(isoDate) {
  const [year, month, day] = String(isoDate).split('-').map(Number);
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000);
}

function addDays(isoDate, days) {
  const [year, month, day] = String(isoDate).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

const text = (value, format) => ({
  userEnteredValue: { stringValue: String(value) },
  ...(format ? { userEnteredFormat: format } : {}),
});
const number = (value, numberFormat, extra = {}) => ({
  userEnteredValue: { numberValue: value },
  userEnteredFormat: { numberFormat, ...extra },
});
const formula = (expression, numberFormat, extra = {}) => ({
  userEnteredValue: { formulaValue: expression },
  userEnteredFormat: { ...(numberFormat ? { numberFormat } : {}), ...extra },
});
const blank = (format) => (format ? { userEnteredFormat: format } : {});

function sizeRequest(sheetId, dimension, startIndex, endIndex, pixelSize) {
  return {
    updateDimensionProperties: {
      range: { sheetId, dimension, startIndex, endIndex },
      properties: { pixelSize },
      fields: 'pixelSize',
    },
  };
}

// ---------------------------------------------------------------------------
// Plaid data -> account models
// ---------------------------------------------------------------------------

// Best guess at the category from Plaid's own category. The bookkeeper can
// change it with the dropdown, and the change is kept on later syncs.
function guessCategory(transaction) {
  const primary = transaction.personal_finance_category?.primary || '';
  const detailed = transaction.personal_finance_category?.detailed || '';
  const moneyIn = Number(transaction.amount) < 0;

  if (
    detailed.includes('CREDIT_CARD_PAYMENT') ||
    detailed.endsWith('ACCOUNT_TRANSFER') ||
    detailed.endsWith('_SAVINGS')
  ) {
    return 'Contra';
  }
  if (primary === 'BANK_FEES') return 'Bank Charges';
  if (primary === 'LOAN_PAYMENTS' || detailed === 'TRANSFER_IN_CASH_ADVANCES_AND_LOANS') return 'Loans';
  if (primary === 'TRAVEL' || primary === 'TRANSPORTATION') return 'Travel';
  if (
    detailed === 'GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING' ||
    detailed === 'GENERAL_SERVICES_CONSULTING_AND_LEGAL'
  ) {
    return 'Professional Fee';
  }
  if (primary === 'RENT_AND_UTILITIES') return 'Office Expenses';
  if (primary === 'INCOME' || (moneyIn && primary === 'TRANSFER_IN')) return 'Collections';
  return 'Others';
}

function defaultDetails(transaction) {
  const place = [transaction.location?.city, transaction.location?.region || transaction.location?.country]
    .filter(Boolean)
    .join(', ');
  return [transaction.merchant_name, place].filter(Boolean).join(' · ');
}

function isPayable(account) {
  return account.type === 'credit' || account.type === 'loan';
}

function accountTabTitle(institutionName, account) {
  const subtype = String(account.subtype || '').toLowerCase();
  let kind;
  if (subtype.includes('line of credit')) kind = 'LOC';
  else if (account.type === 'credit') kind = 'Card';
  else if (account.type === 'loan') kind = 'Loan';
  else kind = subtype ? subtype.replace(/\b\w/g, (letter) => letter.toUpperCase()) : 'Account';
  return [institutionName, kind, account.mask].filter(Boolean).join(' ');
}

// All posted transactions Plaid has for an item (a fresh read from the start,
// separate from the cursor the dashboard uses).
async function fetchItemHistory(client, accessToken) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const transactions = new Map();
    let cursor;
    let hasMore = true;
    try {
      while (hasMore) {
        const response = await client.transactionsSync({
          access_token: accessToken,
          cursor,
          count: 500,
          options: { include_original_description: true },
        });
        const data = response.data;
        for (const transaction of [...data.added, ...data.modified]) {
          transactions.set(transaction.transaction_id, transaction);
        }
        for (const removed of data.removed) {
          transactions.delete(removed.transaction_id);
        }
        hasMore = data.has_more;
        cursor = data.next_cursor;
      }
      return Array.from(transactions.values());
    } catch (error) {
      const code = error?.response?.data?.error_code;
      if (code !== 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' || attempt === 3) throw error;
    }
  }
  return [];
}

// Turns Plaid items into the account list the sheet writer uses.
async function loadAccountsFromPlaid(client, items) {
  const accounts = [];

  for (const item of items) {
    const history = await fetchItemHistory(client, item.access_token);
    for (const account of item.accounts || []) {
      const current = Number(account.balances?.current) || 0;
      accounts.push({
        id: account.account_id,
        title: accountTabTitle(item.institution_name, account),
        payable: isPayable(account),
        signedCurrent: isPayable(account) ? -current : current,
        transactions: history
          .filter((transaction) => transaction.account_id === account.account_id && !transaction.pending)
          .map((transaction) => ({
            id: transaction.transaction_id,
            date: transaction.date,
            reference: transaction.check_number || transaction.payment_meta?.reference_number || '',
            description: transaction.original_description || transaction.name || transaction.merchant_name || '',
            amount: Number(transaction.amount) || 0, // Plaid: positive = money out
            category: guessCategory(transaction),
            details: defaultDetails(transaction),
          })),
      });
    }
  }

  return accounts;
}

// ---------------------------------------------------------------------------
// Tabs: find by hidden developer metadata so renamed tabs are still found
// ---------------------------------------------------------------------------

async function loadTabs(sheets, spreadsheetId) {
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title,index,gridProperties),developerMetadata(metadataKey,metadataValue))',
  });
  return (response.data.sheets || []).map((sheet) => ({
    sheetId: sheet.properties.sheetId,
    title: sheet.properties.title,
    rowCount: sheet.properties.gridProperties?.rowCount || 0,
    columnCount: sheet.properties.gridProperties?.columnCount || 0,
    key: (sheet.developerMetadata || []).find((meta) => meta.metadataKey === TAB_KEY)?.metadataValue || null,
  }));
}

// Creates any missing tabs. `wanted` items: { key, title, index? }.
async function ensureTabs(sheets, spreadsheetId, wanted) {
  let tabs = await loadTabs(sheets, spreadsheetId);
  const usedIds = new Set(tabs.map((tab) => tab.sheetId));
  const usedTitles = new Set(tabs.map((tab) => tab.title));
  const requests = [];

  for (const want of wanted) {
    if (tabs.some((tab) => tab.key === want.key)) continue;

    let title = want.title;
    for (let copy = 2; usedTitles.has(title); copy += 1) title = `${want.title} (${copy})`;
    usedTitles.add(title);

    let sheetId;
    do {
      sheetId = Math.floor(Math.random() * 2000000000);
    } while (usedIds.has(sheetId));
    usedIds.add(sheetId);

    requests.push({
      addSheet: {
        properties: {
          sheetId,
          title,
          ...(want.index != null ? { index: want.index } : {}),
        },
      },
    });
    requests.push({
      createDeveloperMetadata: {
        developerMetadata: {
          metadataKey: TAB_KEY,
          metadataValue: want.key,
          location: { sheetId },
          visibility: 'DOCUMENT',
        },
      },
    });
  }

  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    tabs = await loadTabs(sheets, spreadsheetId);
  }

  return new Map(tabs.filter((tab) => tab.key).map((tab) => [tab.key, tab]));
}

function gridSizeRequest(tab, rowCount, columnCount, frozenRowCount, frozenColumnCount = 0) {
  return {
    updateSheetProperties: {
      properties: {
        sheetId: tab.sheetId,
        gridProperties: {
          rowCount: Math.max(tab.rowCount, rowCount),
          columnCount: Math.max(tab.columnCount, columnCount),
          frozenRowCount,
          frozenColumnCount,
        },
      },
      fields: 'gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)',
    },
  };
}

// ---------------------------------------------------------------------------
// Statement tabs
// ---------------------------------------------------------------------------

const STATEMENT_ID_HEADER = STATEMENT_HEADERS[COL.id];

async function readSavedEntries(sheets, spreadsheetId, statementTabs) {
  if (statementTabs.length === 0) return new Map();

  const response = await sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: statementTabs.map((tab) => `${quoteSheetName(tab.title)}!I1:K`),
    valueRenderOption: 'UNFORMATTED_VALUE',
  });

  const saved = new Map();
  for (const range of response.data.valueRanges || []) {
    for (const row of range.values || []) {
      const id = String(row[2] || '').trim();
      if (id && id !== STATEMENT_ID_HEADER) {
        saved.set(id, { category: String(row[0] ?? ''), details: String(row[1] ?? '') });
      }
    }
  }
  return saved;
}

function statementHeaderRow() {
  return {
    values: STATEMENT_HEADERS.map((label) =>
      text(label, {
        backgroundColor: HEADER_BACKGROUND,
        wrapStrategy: 'WRAP',
        verticalAlignment: 'BOTTOM',
        textFormat: { bold: true },
      })
    ),
  };
}

function lastDayOfPreviousMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex, 0)).toISOString().slice(0, 10);
}

// One block per month, current month on top:
//   October 2026                      <- month heading
//   Concat | Date | ... | Details     <- column headers
//   Opening Balance                   <- last month's closing balance
//   transactions, oldest first, with a running balance
//   (2 blank rows, then the previous month)
// `months` is newest first. Returns the requests and the row of the oldest
// month's opening balance (the starting point for Cash Burn balances).
function buildStatementRequests(tab, account, months, openingDate, saved) {
  const monthKeys = new Set(months.map((month) => monthKey(month.year, month.monthIndex)));
  const transactions = account.transactions
    .filter((transaction) => monthKeys.has(transaction.date.slice(0, 7)))
    .sort((left, right) => left.date.localeCompare(right.date) || left.description.localeCompare(right.description));
  // Sheet amounts: deposits positive, payments negative (the opposite of Plaid).
  const totalChange = transactions.reduce((sum, transaction) => sum - transaction.amount, 0);
  const startingBalance = round(account.signedCurrent - totalChange);

  const byMonth = new Map();
  for (const transaction of transactions) {
    const key = transaction.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(transaction);
  }

  // Work out where every block sits first, so blocks can refer to each other.
  const blocks = [];
  let nextRow = 1;
  for (const month of months) {
    const list = byMonth.get(monthKey(month.year, month.monthIndex)) || [];
    const headingRow = nextRow;
    const openingRow = headingRow + 2;
    const lastRow = openingRow + list.length;
    blocks.push({ ...month, list, headingRow, headerRow: headingRow + 1, openingRow, lastRow });
    nextRow = lastRow + 1 + SPACER_ROWS;
  }

  const rows = [];
  blocks.forEach((block, index) => {
    const older = blocks[index + 1];
    const openingIso = older ? lastDayOfPreviousMonth(block.year, block.monthIndex) : openingDate;
    const bold = { textFormat: { bold: true } };

    rows.push({ values: [monthHeadingCell(block.year, block.monthIndex)] });
    rows.push(statementHeaderRow());
    rows.push({
      values: [
        blank(),
        number(dateSerial(openingIso), STATEMENT_DATE_FORMAT),
        blank(),
        text('Opening Balance', bold),
        blank(),
        blank(),
        older
          ? formula(`=G${older.lastRow}`, MONEY_FORMAT, bold)
          : number(startingBalance, MONEY_FORMAT, bold),
      ],
    });

    block.list.forEach((transaction, offset) => {
      const row = block.openingRow + 1 + offset;
      const kept = saved.get(transaction.id);
      const payment = transaction.amount > 0 ? round(transaction.amount) : null;
      const deposit = transaction.amount < 0 ? round(-transaction.amount) : null;

      rows.push({
        values: [
          formula(`=IF(B${row}="","",INT(B${row})&I${row})`),
          number(dateSerial(transaction.date), STATEMENT_DATE_FORMAT),
          transaction.reference ? text(transaction.reference) : blank(),
          text(transaction.description),
          payment != null ? number(payment, MONEY_FORMAT) : blank(),
          deposit != null ? number(deposit, MONEY_FORMAT) : blank(),
          formula(`=ROUND(G${row - 1}+H${row},2)`, MONEY_FORMAT),
          formula(`=N(F${row})-N(E${row})`, MONEY_FORMAT),
          text(kept ? kept.category : transaction.category),
          text(kept ? kept.details : transaction.details),
          text(transaction.id),
        ],
      });
    });

    for (let spacer = 0; spacer < SPACER_ROWS; spacer += 1) rows.push({ values: [] });
  });

  const sheetId = tab.sheetId;
  const categoryRule = {
    condition: {
      type: 'ONE_OF_LIST',
      values: CATEGORIES.map((category) => ({ userEnteredValue: category })),
    },
    strict: true,
    showCustomUi: true,
  };

  const requests = [
    gridSizeRequest(tab, rows.length + 20, STATEMENT_HEADERS.length, 0),
    // Clear old content, then write the fresh rows.
    { updateCells: { range: { sheetId }, fields: 'userEnteredValue,userEnteredFormat,dataValidation' } },
    { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows, fields: 'userEnteredValue,userEnteredFormat' } },
    sizeRequest(sheetId, 'ROWS', 0, rows.length, 21),
    sizeRequest(sheetId, 'COLUMNS', COL.concat, COL.concat + 1, 160),
    sizeRequest(sheetId, 'COLUMNS', COL.date, COL.reference + 1, 100),
    sizeRequest(sheetId, 'COLUMNS', COL.description, COL.description + 1, 320),
    sizeRequest(sheetId, 'COLUMNS', COL.payment, COL.amount + 1, 110),
    sizeRequest(sheetId, 'COLUMNS', COL.category, COL.category + 1, 140),
    sizeRequest(sheetId, 'COLUMNS', COL.details, COL.details + 1, 240),
    {
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: COL.id, endIndex: COL.id + 1 },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    },
  ];

  for (const block of blocks) {
    requests.push(sizeRequest(sheetId, 'ROWS', block.headingRow - 1, block.headingRow, TITLE_ROW_HEIGHT));
    requests.push(sizeRequest(sheetId, 'ROWS', block.headerRow - 1, block.headerRow, 34));
    if (block.list.length > 0) {
      requests.push({
        setDataValidation: {
          range: {
            sheetId,
            startRowIndex: block.openingRow,
            endRowIndex: block.lastRow,
            startColumnIndex: COL.category,
            endColumnIndex: COL.category + 1,
          },
          rule: categoryRule,
        },
      });
    }
  }

  return { requests, openingRow: blocks[blocks.length - 1].openingRow };
}

// ---------------------------------------------------------------------------
// Cash Burn Report: one tab with a block per month, current month on top.
//   October 2026                                         <- month heading
//   Date | Collections ... Contra | Total | <one column per account> | Total | Burn | Variance
//   Balance                                              <- balances at the end of last month
//   10/1/2026 ... 10/31/2026                             <- one row per day
//   2026-10                                              <- month total (highlighted)
//   (2 blank rows, then the previous month)
// ---------------------------------------------------------------------------

const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const TOTALS_BACKGROUND = { red: 1, green: 0.95, blue: 0.8 };
const SPACER_ROWS = 2;
const TITLE_FONT_SIZE = 12;
const TITLE_ROW_HEIGHT = 28;
const FIRST_COLUMN_WIDTH = 180; // room for "September 2026" in the frozen first column

function monthKey(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function reportHeaderCell(label) {
  return text(label, {
    backgroundColor: HEADER_BACKGROUND,
    wrapStrategy: 'WRAP',
    verticalAlignment: 'BOTTOM',
    textFormat: { bold: true, foregroundColor: HEADER_BLUE },
    borders: { bottom: SOLID_BORDER },
  });
}

function monthHeadingCell(year, monthIndex) {
  return text(`${FULL_MONTHS[monthIndex]} ${year}`, {
    verticalAlignment: 'BOTTOM',
    textFormat: { bold: true, fontSize: TITLE_FONT_SIZE },
  });
}

// Closing balance of a statement tab on a date: the oldest opening balance plus
// every transaction up to that date (blank before Plaid's history starts).
// It does not depend on row order, so month blocks can sit newest-first.
function closingBalanceFormula(statement, dateExpression) {
  const tab = quoteSheetName(statement.title);
  const startBalance = `${tab}!$G$${statement.openingRow}`;
  const startDate = `${tab}!$B$${statement.openingRow}`;
  return (
    `=IF(${dateExpression}<${startDate},"",` +
    `ROUND(${startBalance}+SUMIFS(${tab}!$H:$H,${tab}!$B:$B,"<="&${dateExpression}),2))`
  );
}

// Rows for one month, starting at sheet row `headingRow` (1-based).
function buildCashBurnBlock(headingRow, year, monthIndex, statements) {
  const days = daysInMonth(year, monthIndex);
  const accountCount = statements.length;
  const totalCol = 1 + CATEGORIES.length; // N
  const firstAccountCol = totalCol + 1; // O
  const balanceTotalCol = firstAccountCol + accountCount;
  const burnCol = balanceTotalCol + 1;
  const varianceCol = burnCol + 1;
  const letter = columnLetter;
  const headerRow = headingRow + 1;
  const balanceRow = headingRow + 2;
  const firstDayRow = headingRow + 3;
  const totalRow = firstDayRow + days;

  // Blank before Plaid's history starts, so that day isn't counted as burn.
  const balanceSum = (row) => {
    if (accountCount === 0) return number(0, MONEY_FORMAT);
    const range = `${letter(firstAccountCol)}${row}:${letter(balanceTotalCol - 1)}${row}`;
    return formula(`=IF(COUNT(${range})=0,"",SUM(${range}))`, MONEY_FORMAT);
  };

  const rows = [];
  rows.push({ values: [monthHeadingCell(year, monthIndex)] });
  rows.push({
    values: [
      reportHeaderCell('Date'),
      ...CATEGORIES.map(reportHeaderCell),
      reportHeaderCell('Total'),
      ...statements.map((statement) => reportHeaderCell(statement.title)),
      reportHeaderCell('Total'),
      reportHeaderCell('Burn'),
      reportHeaderCell('Variance'),
    ],
  });

  const openingDate = `DATE(${year},${monthIndex + 1},0)`;
  rows.push({
    values: [
      text('Balance', { textFormat: { bold: true } }),
      ...Array.from({ length: CATEGORIES.length + 1 }, () => blank()),
      ...statements.map((statement) => formula(closingBalanceFormula(statement, openingDate), MONEY_FORMAT)),
      balanceSum(balanceRow),
    ],
  });

  for (let day = 1; day <= days; day += 1) {
    const row = firstDayRow + day - 1;
    const iso = `${monthKey(year, monthIndex)}-${String(day).padStart(2, '0')}`;
    const categoryCells = CATEGORIES.map((_, index) => {
      const column = letter(1 + index);
      const parts = statements.map((statement) => {
        const tab = quoteSheetName(statement.title);
        return `SUMIF(${tab}!$A:$A,INT($A${row})&${column}$${headerRow},${tab}!$H:$H)`;
      });
      return formula(`=${parts.length ? parts.join('+') : '0'}`, MONEY_FORMAT);
    });

    rows.push({
      values: [
        number(dateSerial(iso), REPORT_DATE_FORMAT),
        ...categoryCells,
        formula(`=SUM(B${row}:${letter(totalCol - 1)}${row})`, MONEY_FORMAT),
        ...statements.map((statement) => formula(closingBalanceFormula(statement, `$A${row}`), MONEY_FORMAT)),
        balanceSum(row),
        formula(
          `=IF(OR(${letter(balanceTotalCol)}${row}="",${letter(balanceTotalCol)}${row - 1}=""),"",` +
            `${letter(balanceTotalCol)}${row}-${letter(balanceTotalCol)}${row - 1})`,
          MONEY_FORMAT
        ),
        formula(`=${letter(totalCol)}${row}-N(${letter(burnCol)}${row})`, MONEY_FORMAT),
      ],
    });
  }

  const totalFormat = {
    backgroundColor: TOTALS_BACKGROUND,
    textFormat: { bold: true },
    borders: { top: SOLID_BORDER },
  };
  const sumColumn = (column) =>
    formula(`=SUM(${letter(column)}${firstDayRow}:${letter(column)}${totalRow - 1})`, MONEY_FORMAT, totalFormat);
  rows.push({
    values: [
      text(monthKey(year, monthIndex), totalFormat),
      ...Array.from({ length: CATEGORIES.length + 1 }, (_, index) => sumColumn(1 + index)),
      ...statements.map(() => blank(totalFormat)),
      blank(totalFormat),
      sumColumn(burnCol),
      sumColumn(varianceCol),
    ],
  });

  for (let spacer = 0; spacer < SPACER_ROWS; spacer += 1) rows.push({ values: [] });

  return { rows, headingRow, headerRow, totalRow, columnCount: varianceCol + 1 };
}

// `months` newest first. Returns the requests plus each month's total row.
function buildCashBurnReportRequests(tab, months, statements) {
  const sheetId = tab.sheetId;
  const rows = [];
  const blocks = [];

  for (const month of months) {
    const block = buildCashBurnBlock(rows.length + 1, month.year, month.monthIndex, statements);
    rows.push(...block.rows);
    blocks.push({ ...month, ...block });
  }

  const columnCount = blocks[0]?.columnCount || CATEGORIES.length + 5;
  const requests = [
    gridSizeRequest(tab, rows.length + 10, columnCount, 0, 1),
    { updateCells: { range: { sheetId }, fields: 'userEnteredValue,userEnteredFormat' } },
    { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows, fields: 'userEnteredValue,userEnteredFormat' } },
    sizeRequest(sheetId, 'ROWS', 0, rows.length, 21),
    sizeRequest(sheetId, 'COLUMNS', 0, 1, FIRST_COLUMN_WIDTH),
    sizeRequest(sheetId, 'COLUMNS', 1, columnCount, 100),
  ];
  for (const block of blocks) {
    requests.push(sizeRequest(sheetId, 'ROWS', block.headingRow - 1, block.headingRow, TITLE_ROW_HEIGHT));
    requests.push(sizeRequest(sheetId, 'ROWS', block.headerRow - 1, block.headerRow, 48));
  }

  return { requests, blocks };
}

// ---------------------------------------------------------------------------
// Cash Summary: one row per month, current month on top
// ---------------------------------------------------------------------------

function buildCashSummaryRequests(tab, burnTitle, blocks) {
  const sheetId = tab.sheetId;
  const burnTab = quoteSheetName(burnTitle);
  const rows = [
    { values: [text('Cash Summary', { textFormat: { bold: true, fontSize: TITLE_FONT_SIZE } })] },
    { values: [reportHeaderCell('Month'), ...CATEGORIES.map(reportHeaderCell), reportHeaderCell('Total')] },
  ];

  for (const block of blocks) {
    rows.push({
      values: [
        text(monthKey(block.year, block.monthIndex)),
        ...Array.from({ length: CATEGORIES.length + 1 }, (_, index) =>
          formula(`=${burnTab}!${columnLetter(1 + index)}${block.totalRow}`, MONEY_FORMAT)
        ),
      ],
    });
  }

  return [
    gridSizeRequest(tab, rows.length + 20, CATEGORIES.length + 2, 2, 1),
    { updateCells: { range: { sheetId }, fields: 'userEnteredValue,userEnteredFormat' } },
    { updateCells: { start: { sheetId, rowIndex: 0, columnIndex: 0 }, rows, fields: 'userEnteredValue,userEnteredFormat' } },
    sizeRequest(sheetId, 'ROWS', 0, 1, TITLE_ROW_HEIGHT),
    sizeRequest(sheetId, 'ROWS', 1, 2, 48),
    sizeRequest(sheetId, 'COLUMNS', 0, 1, FIRST_COLUMN_WIDTH),
    sizeRequest(sheetId, 'COLUMNS', 1, CATEGORIES.length + 2, 100),
  ];
}

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

function reportMonths(accounts, now) {
  const today = getZonedDate(now);
  const allDates = accounts.flatMap((account) => account.transactions.map((transaction) => transaction.date));
  const earliest = allDates.length ? allDates.sort()[0] : null;

  const months = [];
  let year = today.year;
  let monthIndex = today.monthIndex;
  while (months.length < MAX_REPORT_MONTHS) {
    months.push({ year, monthIndex });
    const key = monthKey(year, monthIndex);
    if (!earliest || key <= earliest.slice(0, 7)) break;
    monthIndex -= 1;
    if (monthIndex < 0) {
      monthIndex = 11;
      year -= 1;
    }
  }
  return months; // newest first
}

// Writes all bookkeeping tabs for the given accounts.
// `options.suffix` is added to every tab name (used for demo tabs).
async function writeBookkeeping(accounts, now = new Date(), options = {}) {
  const suffix = options.suffix || '';
  const keySuffix = suffix ? `:${suffix.trim()}` : '';
  const config = requireSheetsConfig();
  const sheets = createSheetsClient(createGoogleAuth());
  const spreadsheetId = config.spreadsheetId;

  const sortedAccounts = [...accounts].sort((left, right) => left.title.localeCompare(right.title));
  const months = reportMonths(sortedAccounts, now);
  const summaryKey = `summary${keySuffix}`;
  const burnKey = `cashburn${keySuffix}`;
  const statementKey = (account) => `statement:${account.id}${keySuffix}`;

  // New tabs go after the first tab ("All Banks"): Cash Summary, Cash Burn Report,
  // then statements at the end.
  const tabs = await ensureTabs(sheets, spreadsheetId, [
    { key: summaryKey, title: `Cash Summary${suffix}`, index: 1 },
    { key: burnKey, title: `Cash Burn Report${suffix}`, index: 2 },
    ...sortedAccounts.map((account) => ({ key: statementKey(account), title: `${account.title}${suffix}` })),
  ]);

  const statementTabs = sortedAccounts.map((account) => tabs.get(statementKey(account)));
  const saved = await readSavedEntries(sheets, spreadsheetId, statementTabs);

  // Opening date: the day before the oldest transaction shown (same for every account).
  const monthKeys = new Set(months.map((month) => monthKey(month.year, month.monthIndex)));
  const allDates = sortedAccounts
    .flatMap((account) => account.transactions.map((transaction) => transaction.date))
    .filter((date) => monthKeys.has(date.slice(0, 7)));
  const todayZoned = getZonedDate(now);
  const todayIso = `${monthKey(todayZoned.year, todayZoned.monthIndex)}-${String(todayZoned.day).padStart(2, '0')}`;
  const openingDate = addDays(allDates.length ? allDates.sort()[0] : todayIso, -1);

  const requests = [];
  const statements = sortedAccounts.map((account, index) => {
    const built = buildStatementRequests(statementTabs[index], account, months, openingDate, saved);
    requests.push(...built.requests);
    return { title: statementTabs[index].title, openingRow: built.openingRow };
  });

  const burnTab = tabs.get(burnKey);
  const report = buildCashBurnReportRequests(burnTab, months, statements);
  requests.push(...report.requests);
  requests.push(...buildCashSummaryRequests(tabs.get(summaryKey), burnTab.title, report.blocks));

  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

  return {
    statement_tabs: statementTabs.map((tab) => tab.title),
    cash_burn_tab: burnTab.title,
    months: months.map((month) => monthKey(month.year, month.monthIndex)),
    summary_tab: tabs.get(summaryKey).title,
    transactions: sortedAccounts.reduce((sum, account) => sum + account.transactions.length, 0),
  };
}

async function exportBookkeeping(client, items, now = new Date()) {
  const accounts = await loadAccountsFromPlaid(client, items);
  return writeBookkeeping(accounts, now);
}

module.exports = {
  CATEGORIES,
  isBookkeepingEnabled,
  guessCategory,
  exportBookkeeping,
  writeBookkeeping,
};
