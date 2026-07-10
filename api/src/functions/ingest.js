const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = 'PacingTrackerData';
const PARTITION_KEY = 'tracker';
const ROW_KEY = 'main';

function getClient() {
  const conn = process.env.TRACKER_STORAGE_CONNECTION;
  if (!conn) throw new Error('TRACKER_STORAGE_CONNECTION application setting is not configured');
  return TableClient.fromConnectionString(conn, TABLE_NAME);
}

function uid() {
  return 'c_' + Math.random().toString(36).slice(2, 10);
}

// Accepts: { account: "Jim's Electrical", date: "2026-07-06", rows: [{ name, cost }] }
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
      return { status: 400, jsonBody: { error: "Expected { account, date, rows: [{ name, cost }] }" } };
    }

    const client = getClient();
    try { await client.createTable(); } catch (e) { context.log('createTable note:', e.message); }

    let store;
    try {
      const entity = await client.getEntity(PARTITION_KEY, ROW_KEY);
      store = JSON.parse(entity.json);
    } catch (e) {
      store = { accounts: [], campaigns: [], history: {} };
    }
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

      // 1. Match by Google Ads' permanent campaign ID first — this survives renames.
      let campaign = googleAdsId
        ? store.campaigns.find(c => c.account === account && c.googleAdsId === googleAdsId)
        : null;

      // 2. Fall back to matching by name, but only against campaigns not already linked
      //    to a different ID (covers campaigns added manually, or from before this ID
      //    tracking existed — they'll get linked to their ID automatically below).
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

    await client.upsertEntity(
      {
        partitionKey: PARTITION_KEY,
        rowKey: ROW_KEY,
        json: JSON.stringify(store),
        updatedBy: 'automation:' + account,
        updatedAt: new Date().toISOString()
      },
      'Replace'
    );

    return { status: 200, jsonBody: { ok: true, matched, created, renamed, skipped } };
  }
});
