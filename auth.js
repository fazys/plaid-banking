const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { findUser, sessionVersion } = require('./users');

const COOKIE_NAME = 'plaid_sid';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

const loginAttempts = new Map();
let cachedPasswordHash = null;

function requireAuthConfig() {
  const username = String(process.env.ADMIN_USERNAME || '').trim();
  const password = process.env.ADMIN_PASSWORD;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;
  const secret = String(process.env.SESSION_SECRET || '').trim();

  if (!username || !(password || passwordHash)) {
    const error = new Error(
      'Login is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH) in .env.'
    );
    error.code = 'AUTH_NOT_CONFIGURED';
    throw error;
  }

  if (!secret || secret.length < 16) {
    const error = new Error(
      'SESSION_SECRET is missing or too short. Set a random string of at least 16 characters in .env.'
    );
    error.code = 'AUTH_NOT_CONFIGURED';
    throw error;
  }

  return { username, password, passwordHash, secret };
}

function getPasswordHash() {
  const { password, passwordHash } = requireAuthConfig();
  if (passwordHash) return passwordHash;
  if (!cachedPasswordHash) {
    cachedPasswordHash = bcrypt.hashSync(password, 10);
  }
  return cachedPasswordHash;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  const size = Math.max(a.length, b.length, 1);
  const aPad = Buffer.alloc(size);
  const bPad = Buffer.alloc(size);
  a.copy(aPad);
  b.copy(bPad);
  return crypto.timingSafeEqual(aPad, bPad) && a.length === b.length;
}

function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function getLock(req) {
  const key = clientKey(req);
  const record = loginAttempts.get(key);
  if (!record) return null;
  if (record.lockedUntil && record.lockedUntil > Date.now()) return record;
  if (record.lockedUntil && record.lockedUntil <= Date.now()) {
    loginAttempts.delete(key);
    return null;
  }
  if (record.firstAt && Date.now() - record.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return null;
  }
  return record;
}

function registerFailure(req) {
  const key = clientKey(req);
  const now = Date.now();
  const record = loginAttempts.get(key) || { count: 0, firstAt: now, lockedUntil: 0 };
  record.count += 1;
  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = now + LOGIN_WINDOW_MS;
  }
  loginAttempts.set(key, record);
}

function clearFailures(req) {
  loginAttempts.delete(clientKey(req));
}

function cookieOptions(req) {
  const forced = String(process.env.COOKIE_SECURE || '').toLowerCase();
  const secure = forced === 'true' ? true : forced === 'false' ? false : Boolean(req.secure);
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MS,
  };
}

// Roles: "admin" (the master account from .env) and "user" (created by the admin).
function signSession(account, secret) {
  const payload = Buffer.from(
    JSON.stringify({
      u: account.username,
      r: account.role,
      v: account.version || null,
      exp: Date.now() + SESSION_MS,
    })
  ).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readSession(req) {
  try {
    const { secret, username } = requireAuthConfig();
    const token = req.cookies?.[COOKIE_NAME];
    if (!token || typeof token !== 'string') return null;
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.u || !data.exp || data.exp < Date.now()) return null;

    const role = data.r || 'admin'; // sessions from before roles existed were admin sessions
    if (role === 'admin') {
      return safeEqual(data.u, username) ? { username: data.u, role: 'admin' } : null;
    }
    if (role === 'user') {
      // The user must still exist and must not have had their password reset since.
      const user = findUser(data.u);
      if (!user || data.v !== sessionVersion(user)) return null;
      return { username: user.username, role: 'user' };
    }
    return null;
  } catch (error) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) {
    return res.status(401).json({ success: false, error: 'Please sign in.' });
  }
  req.user = session;
  return next();
}

function setSessionCookie(req, res, account) {
  const { secret } = requireAuthConfig();
  res.cookie(COOKIE_NAME, signSession(account, secret), cookieOptions(req));
}

function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(req), maxAge: 0 });
}

// Returns { username, role, version } for a correct login, otherwise null.
async function verifyLogin(username, password) {
  const config = requireAuthConfig();
  const typed = String(password || '');

  if (safeEqual(String(username || '').trim(), config.username)) {
    const ok = await bcrypt.compare(typed, getPasswordHash());
    return ok ? { username: config.username, role: 'admin' } : null;
  }

  const user = findUser(username);
  // Compare against the admin hash when the user doesn't exist, so timing doesn't reveal usernames.
  const ok = await bcrypt.compare(typed, user ? user.password_hash : getPasswordHash());
  return user && ok ? { username: user.username, role: 'user', version: sessionVersion(user) } : null;
}

function isAdminSession(session) {
  return session?.role === 'admin';
}

// Use after requireAuth: only the admin (master) account may continue.
function requireAdmin(req, res, next) {
  if (!isAdminSession(req.user || readSession(req))) {
    return res.status(403).json({ success: false, error: 'Only the admin can do this.' });
  }
  return next();
}

module.exports = {
  COOKIE_NAME,
  requireAuthConfig,
  requireAuth,
  requireAdmin,
  isAdminSession,
  readSession,
  getLock,
  registerFailure,
  clearFailures,
  setSessionCookie,
  clearSessionCookie,
  verifyLogin,
  LOGIN_WINDOW_MS,
};
