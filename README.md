# Budget Pacing Tracker — multi-user deployment

Same dashboard as before, but data now lives in Azure Table Storage instead of
the browser, so everyone on the allow list sees the same numbers from any
device. Sign-in is Microsoft Entra ID (the same pattern as the Jim's Energy
Pipeline Dashboard), and access is restricted to a specific list of email
addresses.

## What's in this folder

```
index.html                  the dashboard (static, served as-is)
staticwebapp.config.json    routing + auth rules for Static Web Apps
api/                        Azure Functions API (Node.js)
  src/functions/data.js     GET/POST the shared tracker data
  package.json
  host.json
  local.settings.json.example
```

## 1. Create the Azure Static Web App

1. Push this folder to a GitHub repo (a new one, or a folder in an existing
   repo — same as the Pipeline Dashboard setup).
2. In the Azure Portal: **Create a resource → Static Web App**.
   - App location: `/` (the folder with `index.html`)
   - Api location: `api`
   - Output location: leave blank
3. Connect it to the GitHub repo/branch. Azure will add a GitHub Actions
   workflow automatically and deploy on every push.

## 2. Create a storage account for the data

1. Create a new Azure Storage account (Standard, LRS is fine — this is a tiny
   amount of data) or reuse an existing one if you'd rather not spin up
   another resource.
2. Copy its **connection string** (Storage account → Access keys).
3. In the Static Web App → **Configuration → Application settings**, add:
   - `TRACKER_STORAGE_CONNECTION` = that connection string
   - `ALLOWED_EMAILS` = comma-separated list, e.g.
     `phil.mumford@jimselectrical.com.au,cameron@fmms.com.au,miles@fmms.com.au`

   Leaving `ALLOWED_EMAILS` blank allows any authenticated Microsoft account
   through — not recommended, but useful for a quick test.

No manual table creation needed — the API creates the table itself on first
use.

## 3. Sign-in

Static Web Apps includes built-in Entra ID (AAD) login at `/.auth/login/aad`
with no extra app registration required. `staticwebapp.config.json` forces
every route through that login and disables the other social logins. The API
then checks the signed-in email against `ALLOWED_EMAILS` and returns a 403
(shown in the dashboard as an access-denied screen) for anyone not on the
list.

If you'd rather manage access as proper Entra ID app roles instead of an
email list baked into a setting (e.g. so you can add/remove people from the
Azure Portal without redeploying), that's also possible with a custom Entra
ID app registration — let me know if you want that version instead; it's a
bit more setup but scales better past a handful of people.

## 4. Automate daily spend (optional, recommended)

Instead of manually exporting and uploading a CSV each day, Google Ads
Scripts can push the numbers straight to the tracker on a schedule Google
Ads manages itself. This runs on a completely different code path to the
Reports UI export, so it isn't affected by whatever's currently broken with
report downloads.

**One-time setup:**

1. In the Static Web App → **Environment variables**, add:
   - `INGEST_API_KEY` = a random secret string (a password generator's fine —
     20+ random characters, doesn't need to be memorable)
2. Push the updated code (this adds a new `/api/ingest` endpoint that
   accepts data via that key instead of requiring a human login).

**Per Google Ads account (repeat 4 times, once per division):**

1. Open `google-ads-script-template.js` in this folder.
2. In Google Ads → **Tools & Settings → Bulk Actions → Scripts → + New
   script**, paste it in.
3. Fill in the 3 CONFIG lines at the top:
   - `ACCOUNT_NAME` — must match one of the account names already in the
     tracker exactly (check the tabs under Manage campaigns)
   - `WEBHOOK_URL` — your tracker's URL + `/api/ingest`
   - `API_KEY` — the same value you set as `INGEST_API_KEY`
4. Click **Preview** to authorize it and check it finds campaigns and costs
   correctly (check the log output).
5. **Save**, then set a daily **Frequency** (e.g. once a day, early morning)
   from the script's schedule settings.

Once all 4 are running, spend updates itself daily — CSV upload is still
there for backfilling a day you missed, or for anyone without Scripts
access to a given account.

**Note on the `/api/ingest` endpoint:** it's the one intentionally-public
route in the app — reachable without an Entra ID login, since Google Ads
Scripts can't do an interactive sign-in. It's protected instead by the
`x-api-key` header check, so keep that key private the same way you'd keep
any other credential.

## 5. Using it day to day

- Whoever uploads a CSV or edits a campaign, their change is saved centrally
  — everyone else sees it next time they refresh or reopen the page (there's
  a **Refresh** button, and it also refreshes automatically when you switch
  back to the tab).
- Since it's simple shared storage rather than a real multi-user database,
  two people saving at the exact same moment will have the later save win.
  For a handful of people updating campaigns/budgets occasionally, this is
  unlikely to matter — but worth knowing.

## Local testing (optional)

```
cd api
cp local.settings.json.example local.settings.json
# fill in TRACKER_STORAGE_CONNECTION with a real or Azurite connection string
npm install
npm start
```

Then serve `index.html` with the Static Web Apps CLI (`swa start`) so the
`/api` and `/.auth` routes are proxied correctly — opening `index.html`
directly in a browser won't have those.
