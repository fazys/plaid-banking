import { Fragment, useEffect, useState } from 'react';
import { createUser, deleteUser, listUsers, resetUserPassword } from './api.js';

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Admin-only: add, reset and remove dashboard users (connect, sync and send only).
export default function Users({ adminUsername }) {
  const [users, setUsers] = useState([]);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [resetFor, setResetFor] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await listUsers();
        if (!cancelled) setUsers(data.users || []);
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

  async function run(action, successText) {
    setBusy(true);
    setMessage(null);
    try {
      const data = await action();
      setUsers(data.users || []);
      setMessage({ type: 'success', text: successText });
      return true;
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd(event) {
    event.preventDefault();
    const name = username.trim();
    const added = await run(() => createUser(name, password), `User "${name}" added.`);
    if (added) {
      setUsername('');
      setPassword('');
    }
  }

  function openReset(name) {
    setConfirmRemove(null);
    setResetFor(resetFor === name ? null : name);
    setResetPassword('');
    setMessage(null);
  }

  async function handleReset(event) {
    event.preventDefault();
    const name = resetFor;
    const changed = await run(
      () => resetUserPassword(name, resetPassword),
      `Password changed for "${name}". They need to sign in again.`
    );
    if (changed) {
      setResetFor(null);
      setResetPassword('');
    }
  }

  // Ask inside the page (browser pop-ups like confirm() can be blocked, e.g. in the app's browser pane).
  function askRemove(name) {
    setResetFor(null);
    setConfirmRemove(confirmRemove === name ? null : name);
    setMessage(null);
  }

  async function handleDelete(name) {
    const removed = await run(() => deleteUser(name), `User "${name}" removed.`);
    if (removed) setConfirmRemove(null);
  }

  return (
    <section className="card">
      <h1>Users</h1>
      <p className="subtitle">
        <strong>{adminUsername}</strong> is the admin and can see everything. Users you add here can connect
        banks, sync transactions and send to Google Sheets, but never see balances, totals or Settings.
      </p>

      {users.length === 0 ? (
        <p className="empty">No users yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Added</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <Fragment key={user.username}>
                  <tr>
                    <td>{user.username}</td>
                    <td>User (connect, sync, send)</td>
                    <td>{formatDate(user.created_at)}</td>
                    <td className="user-actions">
                      <button type="button" className="small-button" onClick={() => openReset(user.username)} disabled={busy}>
                        {resetFor === user.username ? 'Cancel' : 'Reset password'}
                      </button>
                      <button
                        type="button"
                        className="small-button danger"
                        onClick={() => askRemove(user.username)}
                        disabled={busy}
                      >
                        {confirmRemove === user.username ? 'Keep' : 'Remove'}
                      </button>
                    </td>
                  </tr>
                  {confirmRemove === user.username ? (
                    <tr className="reset-row confirm-row">
                      <td colSpan={4}>
                        <div className="reset-form">
                          <span className="confirm-text">
                            Remove <strong>{user.username}</strong>? They will be signed out and can no longer sign in.
                          </span>
                          <button
                            type="button"
                            className="small-button danger"
                            onClick={() => handleDelete(user.username)}
                            disabled={busy}
                          >
                            Yes, remove
                          </button>
                          <button type="button" className="small-button" onClick={() => setConfirmRemove(null)} disabled={busy}>
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {resetFor === user.username ? (
                    <tr className="reset-row">
                      <td colSpan={4}>
                        <form className="reset-form" onSubmit={handleReset}>
                          <input
                            type="password"
                            autoComplete="new-password"
                            placeholder={`New password for ${user.username} (at least 8 characters)`}
                            aria-label={`New password for ${user.username}`}
                            value={resetPassword}
                            onChange={(event) => setResetPassword(event.target.value)}
                            minLength={8}
                            required
                            disabled={busy}
                          />
                          <button type="submit" className="small-button" disabled={busy}>
                            Save password
                          </button>
                        </form>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form className="settings-form user-form" onSubmit={handleAdd}>
        <h2>Add a user</h2>
        <label>
          Username
          <input
            type="text"
            autoComplete="off"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            disabled={busy}
            required
          />
        </label>
        <label>
          Password (at least 8 characters)
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
            minLength={8}
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          Add user
        </button>
      </form>

      {message ? <p className={`message ${message.type}`}>{message.text}</p> : null}
    </section>
  );
}
