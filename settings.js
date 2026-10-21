const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const dataDir = path.resolve(__dirname, process.env.DATA_DIR || './data');
const settingsPath = path.join(dataDir, 'settings.json');
// Plaid keys entered in Settings (kept apart from the non-secret settings).
const secretsPath = path.join(dataDir, 'secrets.json');

const ALLOWED_KEYS = [
  'PLAID_ENV',
  'PLAID_REDIRECT_URI',
  'GOOGLE_SHEETS_SPREADSHEET_ID',
  'GOOGLE_SHEETS_SINGLE_TAB',
  'BOOKKEEPING_ENABLED',
  'TZ',
  'DAILY_SYNC_ENABLED',
  'DAILY_SYNC_CRON',
  'GOOGLE_PDF_FOLDER_ID',
  'GOOGLE_PDF_SHARE_EMAIL',
];

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'UTC',
];

const defaultsFromEnv = Object.fromEntries(
  ALLOWED_KEYS.map((key) => [key, process.env[key] == null ? '' : String(process.env[key])])
);

function parseSpreadsheetId(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : trimmed;
}

// Accepts a folder ID or a pasted link like https://drive.google.com/drive/folders/<id>?usp=sharing
function parseDriveFolderId(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9-_]+)/) || trimmed.match(/[?&]id=([a-zA-Z0-9-_]+)/);
  return match ? match[1] : trimmed;
}

function loadSavedSettings() {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (error) {
    return {};
  }
}

function applySavedSettings() {
  const saved = loadSavedSettings();
  for (const key of ALLOWED_KEYS) {
    const value = saved[key] == null || saved[key] === '' ? defaultsFromEnv[key] : String(saved[key]);
    if (value === '') {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  if (process.env.TZ) {
    process.env.SCHEDULE_TIMEZONE = process.env.TZ;
  }
}

function getPublicSettings() {
  applySavedSettings();
  return Object.fromEntries(
    ALLOWED_KEYS.map((key) => [key, process.env[key] == null ? '' : String(process.env[key])])
  );
}

function validateSettings(input) {
  const next = {};
  const source = input && typeof input === 'object' ? input : {};

  for (const key of ALLOWED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = String(source[key] == null ? '' : source[key]).trim();

    if (key === 'PLAID_ENV' && value && value !== 'sandbox' && value !== 'production') {
      throw Object.assign(new Error('PLAID_ENV must be sandbox or production.'), { code: 'INVALID_SETTING' });
    }

    if (key === 'PLAID_REDIRECT_URI' && value && !/^https?:\/\/\S+$/i.test(value)) {
      throw Object.assign(new Error('PLAID_REDIRECT_URI must be an http or https URL.'), { code: 'INVALID_SETTING' });
    }

    if (key === 'GOOGLE_SHEETS_SPREADSHEET_ID') {
      const id = parseSpreadsheetId(value);
      if (id && !/^[a-zA-Z0-9-_]+$/.test(id)) {
        throw Object.assign(new Error('Google Sheet ID looks invalid.'), { code: 'INVALID_SETTING' });
      }
      next[key] = id;
      continue;
    }

    if (key === 'GOOGLE_SHEETS_SINGLE_TAB' && value.length > 100) {
      throw Object.assign(new Error('Single tab name must be 100 characters or fewer.'), { code: 'INVALID_SETTING' });
    }

    if (key === 'TZ' && value && !TIMEZONES.includes(value)) {
      throw Object.assign(new Error('Choose a supported timezone.'), { code: 'INVALID_SETTING' });
    }

    if (key === 'BOOKKEEPING_ENABLED' && value && value !== 'true' && value !== 'false') {
      throw Object.assign(new Error('Bookkeeping must be true or false.'), { code: 'INVALID_SETTING' });
    }

    if (key === 'DAILY_SYNC_ENABLED' && value && value !== 'true' && value !== 'false') {
      throw Object.assign(new Error('Daily sync must be true or false.'), { code: 'INVALID_SETTING' });
    }

    if (key === 'DAILY_SYNC_CRON' && value && !cron.validate(value)) {
      throw Object.assign(new Error('Daily sync schedule is not a valid cron expression.'), { code: 'INVALID_SETTING' });
    }

    if (key === 'GOOGLE_PDF_FOLDER_ID') {
      const folderId = parseDriveFolderId(value);
      if (folderId && !/^[a-zA-Z0-9-_]+$/.test(folderId)) {
        throw Object.assign(new Error('Google Drive folder ID or link looks invalid.'), { code: 'INVALID_SETTING' });
      }
      next[key] = folderId;
      continue;
    }

    if (key === 'GOOGLE_PDF_SHARE_EMAIL' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw Object.assign(new Error('PDF share email looks invalid.'), { code: 'INVALID_SETTING' });
    }

    next[key] = value;
  }

  return next;
}

function savePublicSettings(input) {
  const updates = validateSettings(input);
  const saved = { ...loadSavedSettings() };

  for (const key of Object.keys(updates)) {
    if (updates[key] === '') {
      delete saved[key];
    } else {
      saved[key] = updates[key];
    }
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(saved, null, 2), { mode: 0o600 });
  applySavedSettings();
  return getPublicSettings();
}

// ---------------------------------------------------------------------------
// Plaid API keys. Plaid has one client ID and a separate secret per environment.
// Keys saved in Settings win; otherwise .env is used (PLAID_CLIENT_ID,
// PLAID_SECRET_SANDBOX / PLAID_SECRET_PRODUCTION, or the older single
// PLAID_SECRET, which belongs to the PLAID_ENV set in .env).
// Saved keys are never sent back to the browser, only "set / ends in 1a2b".
// ---------------------------------------------------------------------------

const PLAID_KEY_FIELDS = ['PLAID_CLIENT_ID', 'PLAID_SECRET_SANDBOX', 'PLAID_SECRET_PRODUCTION'];
const PLAID_KEY_LABELS = {
  PLAID_CLIENT_ID: 'Plaid client ID',
  PLAID_SECRET_SANDBOX: 'Plaid sandbox secret',
  PLAID_SECRET_PRODUCTION: 'Plaid production secret',
};
const envFilePlaidEnv = String(defaultsFromEnv.PLAID_ENV || 'production').toLowerCase().trim();

function loadSavedSecrets() {
  if (!fs.existsSync(secretsPath)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (error) {
    return {};
  }
}

function envPlaidKey(key) {
  if (process.env[key]) return process.env[key];
  if (key === 'PLAID_SECRET_SANDBOX' && envFilePlaidEnv === 'sandbox') return process.env.PLAID_SECRET || '';
  if (key === 'PLAID_SECRET_PRODUCTION' && envFilePlaidEnv === 'production') return process.env.PLAID_SECRET || '';
  return '';
}

function getPlaidKeys(env) {
  const saved = loadSavedSecrets();
  const secretKey = `PLAID_SECRET_${String(env || '').toUpperCase()}`;
  return {
    clientId: saved.PLAID_CLIENT_ID || envPlaidKey('PLAID_CLIENT_ID'),
    secret: saved[secretKey] || envPlaidKey(secretKey),
  };
}

function getPlaidKeyStatus() {
  const saved = loadSavedSecrets();
  return Object.fromEntries(
    PLAID_KEY_FIELDS.map((key) => {
      const value = saved[key] || envPlaidKey(key);
      return [
        key,
        {
          set: Boolean(value),
          source: saved[key] ? 'settings' : value ? 'env' : null,
          hint: value ? String(value).slice(-4) : null,
        },
      ];
    })
  );
}

function validatePlaidKeys(updates, clear) {
  const next = {};
  const source = updates && typeof updates === 'object' ? updates : {};
  for (const key of PLAID_KEY_FIELDS) {
    const value = String(source[key] ?? '').trim();
    if (!value) continue;
    if (!/^[A-Za-z0-9]{8,64}$/.test(value)) {
      throw Object.assign(new Error(`${PLAID_KEY_LABELS[key]} looks invalid.`), { code: 'INVALID_SETTING' });
    }
    next[key] = value;
  }
  const toClear = (Array.isArray(clear) ? clear : []).filter((key) => PLAID_KEY_FIELDS.includes(key));
  return { next, toClear };
}

function savePlaidKeys({ next, toClear }) {
  if (Object.keys(next).length === 0 && toClear.length === 0) return;
  const saved = loadSavedSecrets();
  for (const key of toClear) delete saved[key];
  Object.assign(saved, next);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(secretsPath, JSON.stringify(saved, null, 2), { mode: 0o600 });
}

// Saves settings and Plaid keys together; nothing is written if any value is invalid.
function saveAllSettings(settings, plaidKeys, clearPlaidKeys) {
  validateSettings(settings);
  const keys = validatePlaidKeys(plaidKeys, clearPlaidKeys);
  const saved = savePublicSettings(settings);
  savePlaidKeys(keys);
  return saved;
}

module.exports = {
  applySavedSettings,
  getPublicSettings,
  savePublicSettings,
  saveAllSettings,
  getPlaidKeys,
  getPlaidKeyStatus,
};
