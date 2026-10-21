import { useEffect, useState } from 'react';
import { getSettings, saveSettings, testPlaidKeys } from './api.js';

const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern (America/New_York)' },
  { value: 'America/Chicago', label: 'Central (America/Chicago)' },
  { value: 'America/Denver', label: 'Mountain (America/Denver)' },
  { value: 'America/Los_Angeles', label: 'Pacific (America/Los_Angeles)' },
  { value: 'America/Phoenix', label: 'Arizona (America/Phoenix)' },
  { value: 'UTC', label: 'UTC' },
];

const EMPTY = {
  PLAID_ENV: 'production',
  PLAID_REDIRECT_URI: '',
  GOOGLE_SHEETS_SPREADSHEET_ID: '',
  GOOGLE_SHEETS_SINGLE_TAB: '',
  BOOKKEEPING_ENABLED: 'false',
  TZ: 'America/New_York',
  DAILY_SYNC_ENABLED: 'true',
  DAILY_SYNC_CRON: '59 11 * * *',
  GOOGLE_PDF_FOLDER_ID: '',
  GOOGLE_PDF_SHARE_EMAIL: '',
};

const EMPTY_KEYS = { PLAID_CLIENT_ID: '', PLAID_SECRET_SANDBOX: '', PLAID_SECRET_PRODUCTION: '' };

const KEY_FIELDS = [
  { key: 'PLAID_CLIENT_ID', label: 'Client ID', type: 'text', help: 'The same client ID is used for sandbox and production.' },
  { key: 'PLAID_SECRET_SANDBOX', label: 'Sandbox secret', type: 'password' },
  { key: 'PLAID_SECRET_PRODUCTION', label: 'Production secret', type: 'password' },
];

function keyStatusText(status) {
  if (!status?.set) return 'Not set';
  const where = status.source === 'settings' ? 'Saved here' : 'From .env';
  return `${where} · ends in ${status.hint}`;
}

export default function Settings({ onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [keys, setKeys] = useState(EMPTY_KEYS);
  const [clearKeys, setClearKeys] = useState([]);
  const [keyStatus, setKeyStatus] = useState({});
  const [bankCounts, setBankCounts] = useState({ sandbox: 0, production: 0 });
  const [serviceAccount, setServiceAccount] = useState(null);
  const [busy, setBusy] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState(null);
  const [plaidTest, setPlaidTest] = useState(null);

  function applyPayload(data) {
    setForm({ ...EMPTY, ...(data.settings || {}) });
    setKeyStatus(data.plaid_keys || {});
    setBankCounts(data.bank_counts || { sandbox: 0, production: 0 });
    setServiceAccount(data.service_account_email || null);
    setKeys(EMPTY_KEYS);
    setClearKeys([]);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getSettings();
        if (!cancelled) {
          applyPayload(data);
          setLoaded(true);
        }
      } catch (error) {
        if (!cancelled) setMessage({ type: 'error', text: error.message });
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function update(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateKey(key, value) {
    setKeys((current) => ({ ...current, [key]: value }));
    if (value) setClearKeys((current) => current.filter((item) => item !== key));
  }

  function toggleClear(key) {
    setClearKeys((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]));
    setKeys((current) => ({ ...current, [key]: '' }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setPlaidTest(null);
    try {
      const result = await saveSettings(form, keys, clearKeys);
      applyPayload(result);
      setMessage({ type: 'success', text: 'Settings saved.' });
      if (onSaved) await onSaved(result);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setBusy(false);
    }
  }

  async function handleTestPlaid() {
    setBusy(true);
    setPlaidTest(null);
    try {
      const data = await testPlaidKeys();
      setPlaidTest(data.results || {});
    } catch (error) {
      setPlaidTest({ error: error.message });
    } finally {
      setBusy(false);
    }
  }

  const currentEnv = form.PLAID_ENV || 'production';
  const otherEnv = currentEnv === 'sandbox' ? 'production' : 'sandbox';
  const hiddenBanks = bankCounts[otherEnv] || 0;
  const unsavedKeys = Object.values(keys).some(Boolean) || clearKeys.length > 0;

  return (
    <section className="card">
      <h1>Settings</h1>
      <p className="subtitle">
        Plaid keys saved here are stored on the server and never shown again. The login password, session secret and
        Google service account key stay in <code>.env</code>.
      </p>

      <form className="settings-form" onSubmit={handleSubmit}>
        <fieldset className="settings-section" disabled={busy || !loaded}>
          <legend>Plaid</legend>

          <label>
            Environment
            <select value={currentEnv} onChange={(event) => update('PLAID_ENV', event.target.value)}>
              <option value="sandbox">Sandbox (test banks, fake data)</option>
              <option value="production">Production (real banks)</option>
            </select>
            <span className="field-help">
              Banks connected in one environment don't work in the other.{' '}
              {hiddenBanks === 0
                ? `No ${otherEnv} banks are saved.`
                : `While ${currentEnv} is selected, ${hiddenBanks} ${otherEnv} bank${hiddenBanks === 1 ? ' is' : 's are'} kept but hidden and not synced.`}{' '}
              Sandbox data is written to the Google Sheet below, so use a test sheet for sandbox.
            </span>
          </label>

          {KEY_FIELDS.map((field) => {
            const status = keyStatus[field.key];
            const clearing = clearKeys.includes(field.key);
            return (
              <label key={field.key}>
                {field.label}
                <input
                  type={field.type}
                  autoComplete="off"
                  placeholder={
                    status?.set
                      ? `${'•'.repeat(16)}${status.hint}   (saved, type here only to replace it)`
                      : 'Paste from the Plaid Dashboard'
                  }
                  value={keys[field.key]}
                  onChange={(event) => updateKey(field.key, event.target.value)}
                />
                <span className="field-help key-status">
                  {clearing ? 'Will be removed when you save (falls back to .env).' : keyStatusText(status)}
                  {status?.source === 'settings' ? (
                    <button type="button" className="link-button" onClick={() => toggleClear(field.key)}>
                      {clearing ? 'Keep it' : 'Remove saved value'}
                    </button>
                  ) : null}
                  {field.help ? <span className="key-help">{field.help}</span> : null}
                </span>
              </label>
            );
          })}

          <label>
            Redirect URI (optional)
            <input
              type="url"
              placeholder="https://your-domain/"
              value={form.PLAID_REDIRECT_URI || ''}
              onChange={(event) => update('PLAID_REDIRECT_URI', event.target.value)}
            />
            <span className="field-help">
              Needed for OAuth banks such as Chase. It must also be added in the Plaid Dashboard.
            </span>
          </label>

          <div className="section-actions">
            <button type="button" className="secondary-button" onClick={handleTestPlaid}>
              Test Plaid keys
            </button>
            {unsavedKeys ? <span className="field-help">Save first to test the keys you just typed.</span> : null}
          </div>
          {plaidTest ? (
            plaidTest.error ? (
              <p className="message error">{plaidTest.error}</p>
            ) : (
              <ul className="test-results">
                {['sandbox', 'production'].map((env) => (
                  <li key={env} className={plaidTest[env]?.ok ? 'ok' : 'bad'}>
                    <strong>{env === 'sandbox' ? 'Sandbox' : 'Production'}:</strong> {plaidTest[env]?.message}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </fieldset>

        <fieldset className="settings-section" disabled={busy || !loaded}>
          <legend>Google Sheets</legend>

          <label>
            Google Sheet URL or ID
            <input
              type="text"
              placeholder="https://docs.google.com/spreadsheets/d/..."
              value={form.GOOGLE_SHEETS_SPREADSHEET_ID || ''}
              onChange={(event) => update('GOOGLE_SHEETS_SPREADSHEET_ID', event.target.value)}
            />
            {serviceAccount ? (
              <span className="field-help">
                Share the sheet with <code>{serviceAccount}</code> as Editor.
              </span>
            ) : null}
          </label>

          <label>
            Single tab name (leave empty for one tab per month)
            <input
              type="text"
              placeholder="All Banks"
              value={form.GOOGLE_SHEETS_SINGLE_TAB || ''}
              onChange={(event) => update('GOOGLE_SHEETS_SINGLE_TAB', event.target.value)}
            />
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={String(form.BOOKKEEPING_ENABLED || 'false') === 'true'}
              onChange={(event) => update('BOOKKEEPING_ENABLED', event.target.checked ? 'true' : 'false')}
            />
            Also update statement tabs, Cash Burn Report and Cash Summary
          </label>
        </fieldset>

        <fieldset className="settings-section" disabled={busy || !loaded}>
          <legend>Daily update</legend>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={String(form.DAILY_SYNC_ENABLED || 'true') !== 'false'}
              onChange={(event) => update('DAILY_SYNC_ENABLED', event.target.checked ? 'true' : 'false')}
            />
            Run the daily Google Sheets update
          </label>

          <label>
            Timezone
            <select value={form.TZ || 'America/New_York'} onChange={(event) => update('TZ', event.target.value)}>
              {TIMEZONES.map((zone) => (
                <option key={zone.value} value={zone.value}>
                  {zone.label}
                </option>
              ))}
            </select>
          </label>

          <label>
            Schedule (cron)
            <input
              type="text"
              value={form.DAILY_SYNC_CRON || ''}
              onChange={(event) => update('DAILY_SYNC_CRON', event.target.value)}
            />
            <span className="field-help">
              Default <code>59 11 * * *</code> is 11:59 AM. <code>59 23 * * *</code> is 11:59 PM.
            </span>
          </label>
        </fieldset>

        <fieldset className="settings-section" disabled={busy || !loaded}>
          <legend>Month-end PDFs</legend>
          <p className="field-help section-help">
            On the first run of a new month, last month is saved as a PDF on the server and uploaded to Google Drive.
            Drive uploads need the Google Drive API turned on for the service account's Google Cloud project.
          </p>

          <label>
            Google Drive folder (ID or link)
            <input
              type="text"
              placeholder="Empty = the folder the Google Sheet is in"
              value={form.GOOGLE_PDF_FOLDER_ID || ''}
              onChange={(event) => update('GOOGLE_PDF_FOLDER_ID', event.target.value)}
            />
            {serviceAccount ? (
              <span className="field-help">
                Share the folder with <code>{serviceAccount}</code> as Editor.
              </span>
            ) : null}
          </label>

          <label>
            Share each PDF with this email
            <input
              type="email"
              placeholder="Empty = the Google Sheet's owner"
              value={form.GOOGLE_PDF_SHARE_EMAIL || ''}
              onChange={(event) => update('GOOGLE_PDF_SHARE_EMAIL', event.target.value)}
            />
          </label>
        </fieldset>

        <button type="submit" disabled={busy || !loaded}>
          {!loaded ? (busy ? 'Loading...' : 'Settings could not be loaded') : busy ? 'Saving...' : 'Save settings'}
        </button>
      </form>

      {message ? <p className={`message ${message.type}`}>{message.text}</p> : null}
    </section>
  );
}
