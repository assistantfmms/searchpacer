const { app } = require('@azure/functions');
const { BlobServiceClient } = require('@azure/storage-blob');
const { TableClient } = require('@azure/data-tables'); // only used for the one-time migration off old Table Storage data
 
const CONTAINER_NAME = 'pacing-tracker-data';
const BLOB_NAME = 'tracker-data.json';
const OLD_TABLE_NAME = 'PacingTrackerData';
const OLD_PARTITION_KEY = 'tracker';
const OLD_ROW_KEY = 'main';
 
// Comma-separated list of email addresses allowed to use the app,
// set as the ALLOWED_EMAILS application setting in the Static Web App.
// If left empty, any authenticated user is allowed through.
function getAllowlist() {
  return (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}
 
function getPrincipal(request) {
  const header = request.headers.get('x-ms-client-principal');
  if (!header) return null;
  try {
    const decoded = Buffer.from(header, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch (e) {
    return null;
  }
}
 
function isAllowed(principal) {
  if (!principal) return false;
  const allowlist = getAllowlist();
  if (allowlist.length === 0) return true;
  const email = (principal.userDetails || '').toLowerCase();
  return allowlist.includes(email);
}
 
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
    return null;
  }
}
 
async function writeBlob(container, body) {
  const blob = container.getBlockBlobClient(BLOB_NAME);
  const content = Buffer.from(JSON.stringify(body), 'utf-8');
  await blob.upload(content, content.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
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
 
app.http('data', {
  methods: ['GET', 'POST'],
  authLevel: 'anonymous', // access control is enforced by Static Web Apps auth + the allowlist below
  route: 'data',
  handler: async (request, context) => {
    const principal = getPrincipal(request);
    if (!isAllowed(principal)) {
      return {
        status: 403,
        jsonBody: {
          error: 'Not authorized for this app.',
          signedInAs: principal ? principal.userDetails : null
        }
      };
    }
 
    let container;
    try {
      container = getContainerClient();
      await container.createIfNotExists();
    } catch (e) {
      context.log('createIfNotExists note:', e.message);
    }
    const blob = container.getBlockBlobClient(BLOB_NAME);
 
    if (request.method === 'GET') {
      try {
        const dl = await blob.download();
        const text = await streamToString(dl.readableStreamBody);
        return { status: 200, jsonBody: JSON.parse(text) };
      } catch (e) {
        if (e.statusCode === 404) {
          const oldData = await readOldTableData(context);
          if (oldData) {
            context.log('Migrated existing data from Table Storage to Blob Storage');
            pruneToCurrentMonth(oldData, context);
            await writeBlob(container, oldData);
            return { status: 200, jsonBody: oldData };
          }
        }
        // no data saved yet
        return { status: 200, jsonBody: null };
      }
    }
 
    if (request.method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return { status: 400, jsonBody: { error: 'Invalid JSON body' } };
      }
      pruneToCurrentMonth(body, context);
      await writeBlob(container, body);
      return { status: 200, jsonBody: { ok: true } };
    }
 
    return { status: 405, jsonBody: { error: 'Method not allowed' } };
  }
});
