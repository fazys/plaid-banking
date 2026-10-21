function formatLinkedAt(value) {
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

// What a simple user sees: connect, sync and send buttons, and which banks are
// connected (status only, never balances or totals).
export default function ConnectBank({
  message,
  busy,
  banks,
  plaidEnv,
  lastSyncAt,
  lastSheetExportAt,
  onConnect,
  onSync,
  onExport,
}) {
  const list = banks || [];
  const connected = list.length > 0;

  return (
    <>
      <section className="card">
        <h1>Connect Your Bank</h1>
        <p className="subtitle">
          Click the button and sign in to your bank through Plaid's secure window. Your bank login is never
          shared with this app.
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
                ? `${list.length} bank${list.length === 1 ? '' : 's'} linked${plaidEnv ? ` · ${plaidEnv}` : ''}`
                : 'No banks connected yet.'}
            </p>
            <p className="plaid-status-meta">Last sync: {formatLinkedAt(lastSyncAt) || 'Not synced yet'}</p>
            <p className="plaid-status-meta">
              Last sent to Google Sheets: {formatLinkedAt(lastSheetExportAt) || 'Not sent yet'}
            </p>
          </div>
        </section>
      </section>

      <section className="card banks-card">
        <div className="transactions-header">
          <h2>Banks</h2>
          {connected ? (
            <p>
              {list.length} bank{list.length === 1 ? '' : 's'}
            </p>
          ) : null}
        </div>
        {connected ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Bank</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((bank, index) => (
                  <tr key={`${bank.bank_name}-${index}`}>
                    <td>
                      <div>{bank.bank_name}</div>
                      {formatLinkedAt(bank.connected_at) ? (
                        <div className="connected-at">Linked {formatLinkedAt(bank.connected_at)}</div>
                      ) : null}
                    </td>
                    <td>
                      <span className="status-pill">Connected</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">No banks connected yet.</p>
        )}
      </section>
    </>
  );
}
