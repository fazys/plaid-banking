function formatConnectedAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export default function Dashboard({
  banks,
  message,
  busy,
  plaidEnv,
  sheetsConfigured,
  spreadsheetUrl,
  sheetTab,
  dailySync,
  lastSyncAt,
  lastSheetExportAt,
  onConnect,
  onSync,
  onExport,
  onOpenReports,
}) {
  const list = banks || [];
  const connected = list.length > 0;
  const syncTime = dailySync?.time || '11:59 AM';
  const syncZone = dailySync?.timezone || 'America/New_York';

  return (
    <>
      <section className="card">
        <h1>Connect Your Bank</h1>
        <p className="subtitle">
          Connect each bank once. The app saves them
          {dailySync?.enabled === false
            ? ' and updates Google Sheets when you click Send to Google Sheets.'
            : ` and updates Google Sheets every day at ${syncTime}.`}
        </p>

        <button type="button" onClick={onConnect} disabled={busy}>
          Connect Bank Account
        </button>
        {connected ? (
          <>
            <button id="sync-button" type="button" onClick={onSync} disabled={busy}>
              Sync Transactions
            </button>
            <button id="sheets-button" type="button" onClick={onExport} disabled={busy}>
              Send to Google Sheets
            </button>
          </>
        ) : null}

        {message ? <p className={`message ${message.type}`}>{message.text}</p> : <p className="message" />}

        <section className={`plaid-status ${connected ? 'is-connected' : 'is-disconnected'}`}>
          <span className="status-dot" aria-hidden="true" />
          <div>
            <p className="plaid-status-title">{connected ? 'Plaid connected' : 'Plaid not connected'}</p>
            <p className="plaid-status-meta">
              {connected
                ? `${list.length} bank${list.length === 1 ? '' : 's'} linked${
                    plaidEnv ? ` · ${plaidEnv}` : ''
                  }`
                : 'Connect a bank to start syncing totals.'}
            </p>
            {connected ? (
              <p className="plaid-status-meta">
                Daily sheet update {dailySync?.enabled === false ? 'is off' : `at ${syncTime} (${syncZone})`}
              </p>
            ) : null}
            <p className="plaid-status-meta">
              Last sync: {formatConnectedAt(lastSyncAt) || 'Not synced yet'}
            </p>
          </div>
        </section>

        <section className={`plaid-status ${sheetsConfigured ? 'is-connected' : 'is-disconnected'}`}>
          <span className="status-dot" aria-hidden="true" />
          <div>
            <p className="plaid-status-title">
              {sheetsConfigured ? 'Google Sheets connected' : 'Google Sheets not connected'}
            </p>
            <p className="plaid-status-meta">
              {sheetsConfigured
                ? `Writing to ${sheetTab || 'the current month tab'}`
                : 'Add the spreadsheet ID and service account to .env.'}
            </p>
            {spreadsheetUrl ? (
              <a className="sheet-link" href={spreadsheetUrl} target="_blank" rel="noreferrer">
                Open Google Sheet
              </a>
            ) : null}
            <p className="plaid-status-meta">
              Last sent to Google Sheets: {formatConnectedAt(lastSheetExportAt) || 'Not sent yet'}
            </p>
            {sheetsConfigured && onOpenReports ? (
              <button type="button" className="link-button reports-link" onClick={onOpenReports}>
                View the sheet's data in Reports
              </button>
            ) : null}
          </div>
        </section>
      </section>
    </>
  );
}
