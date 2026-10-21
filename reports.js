/*
  Reads the Google Sheet's tabs for the dashboard's Reports page (admin only).
  Values come straight from the sheet (already calculated and formatted), with
  the sheet's colors, bold text, alignment, column widths and hidden columns,
  so the page looks like the sheet.
*/
const { createGoogleAuth, createSheetsClient, requireSheetsConfig, quoteSheetName } = require('./sheets');

const MONTH_TAB_PATTERN = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Oct|Nov|Dec) \d{4}$/;
const MAX_ROWS = 3000;
const DEFAULT_FONT_SIZE = 10;

function tabKind(title, bookkeepingKey) {
  const key = String(bookkeepingKey || '');
  if (key.startsWith('statement:')) return 'statement';
  if (key.startsWith('summary')) return 'summary';
  if (key.startsWith('cashburn')) return 'cash_burn';
  const singleTab = String(process.env.GOOGLE_SHEETS_SINGLE_TAB || '').trim();
  if ((singleTab && title === singleTab) || MONTH_TAB_PATTERN.test(title)) return 'banks';
  return 'other';
}

async function listReportTabs() {
  const { spreadsheetId } = requireSheetsConfig();
  const sheets = createSheetsClient(createGoogleAuth());
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(sheetId,title,index,hidden),developerMetadata(metadataKey,metadataValue))',
  });

  return (response.data.sheets || [])
    .filter((sheet) => !sheet.properties.hidden)
    .map((sheet) => {
      const key = (sheet.developerMetadata || []).find((meta) => meta.metadataKey === 'bookkeepingTab')?.metadataValue;
      return {
        title: sheet.properties.title,
        sheet_id: sheet.properties.sheetId,
        kind: tabKind(sheet.properties.title, key),
      };
    });
}

function toHex(color) {
  if (!color) return null;
  const channel = (value) => Math.round((Number(value) || 0) * 255).toString(16).padStart(2, '0');
  return `#${channel(color.red)}${channel(color.green)}${channel(color.blue)}`;
}

function isWhite(hex) {
  return !hex || hex === '#ffffff';
}

function isBlack(hex) {
  return !hex || hex === '#000000';
}

// Turns one Google Sheets cell into a small object for the browser.
function toCell(value) {
  if (!value) return null;
  const format = value.effectiveFormat || {};
  const text = value.formattedValue || '';
  const background = toHex(format.backgroundColor);
  const color = toHex(format.textFormat?.foregroundColor);
  const cell = {};

  if (text) cell.t = text;
  if (!isWhite(background)) cell.bg = background;
  if (!isBlack(color)) cell.color = color;
  if (format.textFormat?.bold) cell.bold = true;
  const size = format.textFormat?.fontSize;
  if (size && size !== DEFAULT_FONT_SIZE) cell.size = size;
  const align = format.horizontalAlignment || (value.effectiveValue?.numberValue != null ? 'RIGHT' : null);
  if (align && align !== 'LEFT') cell.align = align.toLowerCase();
  if (format.wrapStrategy === 'WRAP') cell.wrap = true;
  if (format.borders?.bottom?.style && format.borders.bottom.style !== 'NONE') cell.borderBottom = true;
  if (format.borders?.top?.style && format.borders.top.style !== 'NONE') cell.borderTop = true;

  // Rich text inside one cell (e.g. green "Total money in:" then black amount).
  if (Array.isArray(value.textFormatRuns) && value.textFormatRuns.length > 0 && text) {
    cell.runs = value.textFormatRuns.map((run) => ({
      start: run.startIndex || 0,
      bold: run.format?.bold,
      color: toHex(run.format?.foregroundColor),
    }));
  }

  return Object.keys(cell).length ? cell : null;
}

async function readReportTab(title) {
  const { spreadsheetId } = requireSheetsConfig();
  const sheets = createSheetsClient(createGoogleAuth());
  const response = await sheets.spreadsheets.get({
    spreadsheetId,
    ranges: [quoteSheetName(title)],
    includeGridData: true,
    fields:
      'sheets(properties(sheetId,title),data(columnMetadata(hiddenByUser,pixelSize),' +
      'rowData(values(formattedValue,effectiveValue(numberValue),' +
      'textFormatRuns(startIndex,format(bold,foregroundColor)),' +
      'effectiveFormat(backgroundColor,horizontalAlignment,wrapStrategy,' +
      'borders(top(style),bottom(style)),textFormat(bold,fontSize,foregroundColor))))))',
  });

  const sheet = response.data.sheets?.[0];
  const grid = sheet?.data?.[0] || {};
  const columnMeta = grid.columnMetadata || [];
  const rawRows = (grid.rowData || []).slice(0, MAX_ROWS).map((row) => (row.values || []).map(toCell));

  // Drop empty rows/columns at the end, and columns hidden in the sheet.
  let lastRow = -1;
  let lastColumn = -1;
  rawRows.forEach((row, rowIndex) => {
    row.forEach((cell, columnIndex) => {
      if (cell && (cell.t || cell.bg)) {
        lastRow = Math.max(lastRow, rowIndex);
        lastColumn = Math.max(lastColumn, columnIndex);
      }
    });
  });

  const visibleColumns = [];
  for (let index = 0; index <= lastColumn; index += 1) {
    if (!columnMeta[index]?.hiddenByUser) visibleColumns.push(index);
  }

  return {
    title: sheet?.properties?.title || title,
    sheet_id: sheet?.properties?.sheetId ?? null,
    columns: visibleColumns.map((index) => ({ width: columnMeta[index]?.pixelSize || 100 })),
    rows: rawRows.slice(0, lastRow + 1).map((row) => visibleColumns.map((index) => row[index] || null)),
  };
}

module.exports = { listReportTabs, readReportTab };
