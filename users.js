/*
  Dashboard users created by the admin (role "user").
  The admin ("master") account itself comes from ADMIN_USERNAME / ADMIN_PASSWORD in .env.
  Users are stored in <DATA_DIR>/users.json with bcrypt password hashes.
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const dataDir = path.resolve(__dirname, process.env.DATA_DIR || './data');
const usersPath = path.join(dataDir, 'users.json');
const USERNAME_PATTERN = /^[a-zA-Z0-9._@-]{3,40}$/;
const MIN_PASSWORD_LENGTH = 8;

function userError(message) {
  return Object.assign(new Error(message), { code: 'INVALID_USER' });
}

function loadUsers() {
  if (!fs.existsSync(usersPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    return Array.isArray(raw.users) ? raw.users : [];
  } catch (error) {
    return [];
  }
}

function saveUsers(users) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(usersPath, JSON.stringify({ users }, null, 2), { mode: 0o600 });
}

function sameName(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function findUser(username) {
  return loadUsers().find((user) => sameName(user.username, username)) || null;
}

function listUsers() {
  return loadUsers().map((user) => ({
    username: user.username,
    role: 'user',
    created_at: user.created_at || null,
  }));
}

function validatePassword(password) {
  if (String(password || '').length < MIN_PASSWORD_LENGTH) {
    throw userError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}

async function createUser(username, password, adminUsername) {
  const name = String(username || '').trim();
  if (!USERNAME_PATTERN.test(name)) {
    throw userError('Username must be 3–40 characters: letters, numbers, dot, dash, underscore or @.');
  }
  if (sameName(name, adminUsername)) {
    throw userError('That username is the admin account.');
  }
  validatePassword(password);

  const users = loadUsers();
  if (users.some((user) => sameName(user.username, name))) {
    throw userError('A user with that username already exists.');
  }

  users.push({
    username: name,
    role: 'user',
    password_hash: await bcrypt.hash(String(password), 10),
    created_at: new Date().toISOString(),
  });
  saveUsers(users);
  return { username: name, role: 'user' };
}

async function setUserPassword(username, password) {
  validatePassword(password);
  const users = loadUsers();
  const user = users.find((entry) => sameName(entry.username, username));
  if (!user) throw userError('User not found.');
  user.password_hash = await bcrypt.hash(String(password), 10);
  user.password_changed_at = new Date().toISOString();
  saveUsers(users);
}

function deleteUser(username) {
  const users = loadUsers();
  const next = users.filter((user) => !sameName(user.username, username));
  if (next.length === users.length) throw userError('User not found.');
  saveUsers(next);
}

// Changes when the password changes, so old sessions stop working after a reset.
function sessionVersion(user) {
  return crypto.createHash('sha256').update(String(user.password_hash || '')).digest('base64url').slice(0, 16);
}

module.exports = {
  findUser,
  listUsers,
  createUser,
  setUserPassword,
  deleteUser,
  sessionVersion,
};
