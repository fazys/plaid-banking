# Plaid bank totals → Google Sheets

Connect banks with Plaid, then write daily totals into Google Sheets. The sheet uses one tab per month (`Sept 2026`, `Oct 2026`, …) and one date column per day, with the newest date on the left.

**Single-tab option:** set `GOOGLE_SHEETS_SINGLE_TAB=All Banks` (or fill in "Single tab name" on the Settings page) to keep every month on one tab instead. Each month is a block of rows: a month heading (`October 2026`), a header row (`Bank`, then one column per day, newest on the left), one row per bank, and a highlighted `All banks` total row, followed by two blank rows. The current month is on top; when a new month starts, its block is added above and older months move down. The month-end PDF then contains just that month's block.

## What you need

- Node.js 18 or later
- A Plaid account (`PLAID_CLIENT_ID`, `PLAID_SECRET`), set in `.env` or later in **Settings → Plaid**
- A Google Sheet shared with your service account as **Editor**
- The Google service account JSON key

## Local run

```bash
npm install
cp .env.example .env
```

Put your secrets in `.env`, including login:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=choose-a-strong-password
SESSION_SECRET=long-random-string
```

Save the Google key as `google-service-account.json` in this folder. Then:

```bash
npm run build
npm start
```

Open http://localhost:3000, sign in, connect each bank once, then click **Send to Google Sheets**. Connected banks are saved in `data/items.json` so they survive restarts.

To work on the React UI with live reload, run `npm start` and `npm run dev:client` together, then open http://localhost:5173.

## Bookkeeping tabs (optional)

Set `BOOKKEEPING_ENABLED=true` (or tick "Also update statement tabs, Cash Burn Report and Cash Summary" in Settings). Every "Send to Google Sheets" and every daily update then also writes:

- **One statement tab per account** (e.g. `Chase Card 4412`, `U.S. Bank Checking 0594`), filled from Plaid with posted transactions. Each month is a block, current month on top: a month heading, the column headers, an Opening Balance row (last month's closing balance) and that month's transactions in date order, followed by two blank rows. Columns: Concat (date serial & category, e.g. `46136Travel`), Date, Reference Number, Description, Payment, Deposit, Running Balance (negative for cards and lines of credit), Transaction Amount (deposits positive, payments negative), Category (dropdown) and Details. Category starts with a best guess from Plaid's category. Changes to Category and Details are kept on every later sync (a hidden column holds Plaid's transaction ID).
- **`Cash Burn Report`**: one tab with a block per month, current month on top (up to 24 months). Each block has a month heading, a header row, a Balance row (end of the previous month), one row per day and a highlighted month total row, followed by two blank rows. Each day shows each category's total (`SUMIF` on the statement tabs' Concat column), each account's closing balance, the total balance, **Burn** (today's total balance minus yesterday's) and **Variance** (category Total minus Burn). Variance is 0 when every transaction has a category and the balances reconcile.
- **`Cash Summary`**: one row per month (current month on top) linked to each month's total row in the Cash Burn Report.

Statement tabs hold whatever history Plaid returns (it keeps up to 24 months), so transactions older than that drop off on later syncs.

Cash Burn and Cash Summary are formulas only, so changing a category in a statement tab updates them immediately. The app rewrites these tabs on each sync, so put notes in the statement tabs' Details column rather than in the report tabs. Categories: Collections, Owners Draws, COS, CAC, Subscriptions, Professional Fee, Office Expenses, Travel, Loans, Bank Charges, Others, Contra.

## Daily update at 11:59 AM

While `node server.js` is running, the app syncs every connected bank and updates the sheet **every day at 11:59 AM**.

Default timezone is `America/New_York` (US Eastern). Change it with:

```env
TZ=America/New_York
DAILY_SYNC_ENABLED=true
DAILY_SYNC_CRON=59 11 * * *
```

Other US options: `America/Chicago`, `America/Denver`, `America/Los_Angeles`.

When a month ends, the first run in the new month also saves the finished tab as a PDF (`Sept 2026.pdf`, then `Oct 2026.pdf`, and so on). It tries to put that file next to your spreadsheet in Google Drive, and keeps a copy in `data/pdfs/` on the server. Enable the **Google Drive API** on the same Google Cloud project as the service account. Optional:

```env
GOOGLE_PDF_FOLDER_ID=
GOOGLE_PDF_SHARE_EMAIL=
```

Run one update immediately:

```bash
node server.js --daily
```

If you prefer OS cron instead of the built-in schedule, set `DAILY_SYNC_ENABLED=false` and add:

```cron
59 11 * * * cd /opt/plaid && /usr/bin/node server.js --daily
```

## Deploy on DigitalOcean (Droplet)

Use a **Droplet**, not App Platform. This app saves connected banks in `data/items.json`, and App Platform disks are wiped on every deploy.

Never commit `.env`, `google-service-account.json` or anything in `data/` (they are in `.gitignore`). The code itself can live in a public repo because all secrets stay on the server.

### 1. Create the Droplet

1. Create an Ubuntu Droplet (1 GB is enough). Give it a domain if you want HTTPS, such as `banks.example.com`.
2. In the DigitalOcean firewall, allow SSH (22). For HTTPS also allow 80 and 443. For a quick HTTP test, allow 3000.
3. Put production values in local `.env`:

```env
PLAID_ENV=production
PLAID_REDIRECT_URI=https://banks.example.com/
TZ=America/New_York
DAILY_SYNC_ENABLED=true
ADMIN_USERNAME=admin
ADMIN_PASSWORD=choose-a-strong-password
SESSION_SECRET=long-random-string
```

4. In the Plaid Dashboard, add that same redirect URI and your live site origin.

### 2. Clone from GitHub, then copy secrets

On the Droplet:

```bash
apt-get update && apt-get install -y git
git clone -b production https://github.com/YOUR_GITHUB_USER/plaid-banking.git /opt/plaid
```

From your laptop, copy only the secret files (not the whole project):

```bash
scp .env google-service-account.json root@YOUR_DROPLET_IP:/opt/plaid/
```

Then on the Droplet:

```bash
cd /opt/plaid
chmod +x deploy/setup-droplet.sh deploy/pull.sh
sudo ./deploy/setup-droplet.sh
```

The script installs Node.js, installs packages, builds the React app, and starts a systemd service named `plaid`.

### Branches and automatic deploys

- **`production`**: what runs on the server. Every push to `production` is deployed automatically within about a minute.
- **`staging`**: for work in progress. It is not deployed anywhere. Merge it into `production` when it's ready to go live.

Turn on automatic deploys once on the Droplet:

```bash
cd /opt/plaid
sudo ./deploy/install-auto-deploy.sh
```

This adds a systemd timer (`plaid-auto-deploy`) that checks GitHub every minute. When `production` has a new commit, it updates the code, runs `npm ci` if packages changed, rebuilds the dashboard and restarts the `plaid` service. `.env`, the Google key and `data/` are never touched. Watch it with `journalctl -u plaid-auto-deploy -f`.

To update by hand instead: `cd /opt/plaid && sudo ./deploy/pull.sh`.

### Optional: upload without git

```bash
chmod +x deploy/upload.sh deploy/setup-droplet.sh
./deploy/upload.sh root@YOUR_DROPLET_IP
```

That copies `.env` and `google-service-account.json`. Do not commit those files.

HTTP test URL: `http://YOUR_DROPLET_IP:3000`

For HTTPS with a domain pointed at the Droplet:

```bash
cd /opt/plaid
sudo DOMAIN=banks.example.com ./deploy/setup-droplet.sh
```

Then open `https://banks.example.com`, **sign in**, connect each bank once, and click **Send to Google Sheets**. The daily job keeps running at 11:59 AM US Eastern as long as the service is up.

Useful commands:

```bash
sudo systemctl status plaid
sudo journalctl -u plaid -f
sudo systemctl restart plaid
```

On hosts without a key file, paste the JSON into `GOOGLE_SERVICE_ACCOUNT_JSON` instead of using `google-service-account.json`.

## Production Plaid notes

- Set `PLAID_ENV=production` and use the production secret.
- For OAuth banks such as Chase, set `PLAID_REDIRECT_URI` to your public HTTPS URL and allowlist that URL in the Plaid Dashboard.

## Reports page

The admin menu has **Reports**, which shows the Google Sheet's tabs inside the dashboard: All Banks, Cash Summary, Cash Burn Report and each statement tab (pick one under **Statements**). The data is read live from the sheet with its colors and bold text, so it always matches the sheet; **Refresh** reloads it and **Open in Google Sheets** jumps to the same tab. Users (non-admin) don't get this page. To turn the page off completely, set `REPORTS_ENABLED=false` in `.env` and restart the app: the menu item and dashboard link disappear and the server refuses report requests.

## Settings page

Settings (admin only) is grouped into **Plaid**, **Google Sheets**, **Daily update** and **Month-end PDFs**.

- **Plaid keys:** enter the client ID and a separate **sandbox** and **production** secret. Saved keys go to `data/secrets.json` (owner-only file, not in git) and are never shown again, only "ends in 1a2b". Keys saved here win over `.env`; the old single `PLAID_SECRET` in `.env` still works for the `PLAID_ENV` set in `.env`. **Test Plaid keys** checks both environments with a harmless Plaid call.
- **Environment switch:** each connected bank remembers whether it was connected in sandbox or production. Only banks from the selected environment are shown, synced and sent to Google Sheets; the others are kept for when you switch back. Sandbox data goes to the configured Google Sheet, so point it at a test sheet while testing.

## Accounts and roles

- **Admin (master):** the `ADMIN_USERNAME` / `ADMIN_PASSWORD` login from `.env`. Sees the whole dashboard and Settings, and manages users in **Settings → Users** (add, reset password, remove). `IS_ADMIN` is no longer used.
- **User:** added by the admin. A user can **Connect Bank Account**, **Sync Transactions** and **Send to Google Sheets**, and sees which banks are connected (name, linked date, status) plus the last sync and last sent times. Users never see balances or totals, the Google Sheet link, or Settings. The server enforces this on every route, so users can't reach that data through the API either. Banks a user connects are added to the same list the admin syncs.

Users are stored in `data/users.json` (or `DATA_DIR/users.json`) with bcrypt password hashes. Removing a user or resetting their password signs them out immediately.

## Security

The dashboard is behind a username and password. Sessions use an httpOnly cookie. Bank `access_token` values and `PLAID_SECRET` stay on the server.

Never expose these to the browser:

- `PLAID_SECRET`
- `access_token`
- `ADMIN_PASSWORD`
- `SESSION_SECRET`
- `google-service-account.json`
- `data/items.json`
- `data/users.json`

Optional: set `DAILY_SYNC_SECRET` and send it as header `x-sync-secret` when calling `POST /api/daily_sync`. If that secret is unset, daily_sync also requires a signed-in session.
