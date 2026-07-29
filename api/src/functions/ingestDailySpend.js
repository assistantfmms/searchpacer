const { app } = require('@azure/functions');
const { BigQuery } = require('@google-cloud/bigquery');

const PROJECT_ID = 'jims-leads-pipeline';
const DATASET_ID = 'google_ads_spend';
const TABLE_ID = 'daily_spend_live';

function getBigQueryClient() {
  const keyJson = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GCP_SERVICE_ACCOUNT_KEY application setting is not configured');
  const credentials = JSON.parse(keyJson);
  return new BigQuery({ projectId: PROJECT_ID, credentials });
}

// Accepts: { account: "Electrical", date: "2026-07-29", rows: [{ id, name, cost }] }
// Auth: header x-api-key must match the INGEST_API_KEY application setting —
// same shared-key pattern as the pacing tracker's /api/ingest, since Ads Scripts
// can't do interactive sign-in.
app.http('ingestDailySpend', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'ingest-daily-spend',
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
      return { status: 400, jsonBody: { error: "Expected { account, date, rows: [{ id, name, cost }] }" } };
    }

    const now = new Date().toISOString();
    const bqRows = rows
      .map(r => {
        const spend = Number(r.cost);
        if (isNaN(spend)) return null;
        return {
          division: account,
          campaign_id: r.id ? String(r.id) : null,
          campaign_name: r.name || null,
          spend_date: date,
          spend: spend,
          ingested_at: now
        };
      })
      .filter(Boolean);

    if (bqRows.length === 0) {
      return { status: 200, jsonBody: { ok: true, inserted: 0 } };
    }

    try {
      await getBigQueryClient().dataset(DATASET_ID).table(TABLE_ID).insert(bqRows);
    } catch (err) {
      context.log('BigQuery insert error:', JSON.stringify(err.errors || err.message));
      return { status: 500, jsonBody: { error: 'BigQuery insert failed', details: err.errors || err.message } };
    }

    return { status: 200, jsonBody: { ok: true, inserted: bqRows.length } };
  }
});
