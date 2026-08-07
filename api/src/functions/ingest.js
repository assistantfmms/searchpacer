const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const { TableClient } = require('@azure/data-tables'); // only used for the one-time migration off old Table Storage data
 
const CONTAINER_NAME = 'pacing-tracker-data';
const BLOB_NAME = 'tracker-data.json';
const OLD_TABLE_NAME = 'PacingTrackerData';
const OLD_PARTITION_KEY = 'tracker';
const OLD_ROW_KEY = 'main';
 
function getContainerClient() {
  const conn = process.env.TRACKER_STORAGE_CONNECTION;
  if (!conn) throw new Error('TRACKER_STORAGE_CONNECTION application setting is not configured');
  return BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER_NAME);
}
 
async function streamToString(readable) {
  const chunks = [];
  for await (const chunk of readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}
 
// Reads whatever's left in the old Table Storage location, if anything. Table Storage caps a
// single field at 64KB, which is what broke ingestion once history grew past that — but a GET
// still works fine on whatever was last successfully saved before it crossed that limit, so this
// recovers the most recent good copy rather than losing it.
async function readOldTableData(context) {
  try {
    const conn = process.env.TRACKER_STORAGE_CONNECTION;
    if (!conn) return null;
    const client = TableClient.fromConnectionString(conn, OLD_TABLE_NAME);
    const entity = await client.getEntity(OLD_PARTITION_KEY, OLD_ROW_KEY);
    return JSON.parse(entity.json);
  } catch (e) {
    return null; // nothing there, or already inaccessible — nothing to migrate either way
  }
}
 
async function writeStore(store) {
  const container = getContainerClient();
  const blob = container.getBlockBlobClient(BLOB_NAME);
  const content = Buffer.from(JSON.stringify(store), 'utf-8');
  await blob.upload(content, content.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
}
 
async function readStore(context) {
  const container = getContainerClient();
  try { await container.createIfNotExists(); } catch (e) { context.log('createIfNotExists note:', e.message); }
  const blob = container.getBlockBlobClient(BLOB_NAME);
  try {
    const dl = await blob.download();
    const text = await streamToString(dl.readableStreamBody);
    return JSON.parse(text);
  } catch (e) {
    if (e.statusCode === 404) {
      // First run on the new storage — check for existing data left behind in the old
      // Table Storage location and migrate it across automatically, once, so nothing is lost.
      const oldData = await readOldTableData(context);
      if (oldData) {
        context.log('Migrated existing data from Table Storage to Blob Storage');
        pruneToCurrentMonth(oldData, context);
        await writeStore(oldData);
        return oldData;
      }
      return { accounts: [], campaigns: [], history: {} };
    }
    throw e;
  }
}
 
function uid() {
  return 'c_' + Math.random().toString(36).slice(2, 10);
}
 
// Drops any spend history and per-month budgets outside the current calendar month, keeping the
// stored data lean permanently rather than growing without bound. Carries forward the most recent
// applicable budget into the current month first, so a campaign's budget doesn't silently reset to
// $0 right when the month rolls over.
function pruneToCurrentMonth(store, context) {
  const currentMonthKey = new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
  let historyDropped = 0;
 
  Object.keys(store.history || {}).forEach(campaignId => {
    const before = store.history[campaignId].length;
    store.history[campaignId] = store.history[campaignId].filter(e => e.date && e.date.slice(0, 7) === currentMonthKey);
    historyDropped += before - store.history[campaignId].length;
    if (store.history[campaignId].length === 0) delete store.history[campaignId];
  });
 
  (store.campaigns || []).forEach(c => {
    if (!c.budgets) return;
    const keep = {};
    if (c.budgets[currentMonthKey] !== undefined) {
      keep[currentMonthKey] = c.budgets[currentMonthKey];
    } else {
      const priorKeys = Object.keys(c.budgets).filter(k => k < currentMonthKey).sort();
      if (priorKeys.length) keep[currentMonthKey] = c.budgets[priorKeys[priorKeys.length - 1]];
    }
    c.budgets = keep;
  });
 
  if (historyDropped > 0 && context) context.log(`Pruned ${historyDropped} history entries outside ${currentMonthKey}`);
  return store;
}
 
// Accepts: { account: "Jim's Electrical", date: "2026-07-06", rows: [{ name, cost, id }] }
// Auth: header x-api-key must match the INGEST_API_KEY application setting.
// This route is deliberately NOT behind Static Web Apps' Entra ID login (see staticwebapp.config.json) —
// Google Ads Scripts can't do interactive sign-in, so it authenticates with this shared key instead.
app.http('ingest', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'ingest',
  handler: async (request, context) => {
    const expectedKey = process.env.INGEST_API_KEY;
    const providedKey = request.headers.get('x-api-key');
    if (!expectedKey || !providedKey || providedKey !== expectedKey) {
      return { status: 401, jsonBody: { error: 'Invalid or missing API key' } };
    }
 
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return { status: 400, jsonBody: { error: 'Invalid JSON body' } };
    }
 
    const { account, date, rows } = body || {};
    if (!account || !date || !Array.isArray(rows)) {
      return { status: 400, jsonBody: { error: "Expected { account, date, rows: [{ name, cost, id }] }" } };
    }
 
    const store = await readStore(context);
    if (!store.accounts) store.accounts = [];
    if (!store.campaigns) store.campaigns = [];
    if (!store.history) store.history = {};
    if (!store.accounts.includes(account)) store.accounts.push(account);
 
    let matched = 0, created = 0, renamed = 0, skipped = 0;
    rows.forEach(r => {
      const name = (r.name || '').toString().trim();
      const cost = Number(r.cost);
      const googleAdsId = r.id ? String(r.id).trim() : null;
      if (!name || isNaN(cost)) { skipped++; return; }
      const norm = name.toLowerCase();
 
      let campaign = googleAdsId
        ? store.campaigns.find(c => c.account === account && c.googleAdsId === googleAdsId)
        : null;
 
      if (!campaign) {
        campaign = store.campaigns.find(c => c.account === account && !c.googleAdsId && c.name.trim().toLowerCase() === norm);
      }
 
      if (campaign) {
        matched++;
        if (googleAdsId && !campaign.googleAdsId) campaign.googleAdsId = googleAdsId;
        if (campaign.name.trim().toLowerCase() !== norm) { campaign.name = name; renamed++; }
      } else {
        campaign = { id: uid(), name, account, budgets: {}, googleAdsId };
        store.campaigns.push(campaign);
        created++;
      }
 
      if (!store.history[campaign.id]) store.history[campaign.id] = [];
      const hist = store.history[campaign.id];
      const idx = hist.findIndex(e => e.date === date);
      if (idx >= 0) hist[idx].spend = cost;
      else hist.push({ date, spend: cost });
    });
 
    pruneToCurrentMonth(store, context);
    await writeStore(store);
 
    return { status: 200, jsonBody: { ok: true, matched, created, renamed, skipped } };
  }
});
