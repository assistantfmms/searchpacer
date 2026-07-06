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

## 4. Using it day to day

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
