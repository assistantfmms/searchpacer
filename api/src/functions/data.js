const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');

const TABLE_NAME = 'PacingTrackerData';
const PARTITION_KEY = 'tracker';
const ROW_KEY = 'main';

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

function getClient() {
  const conn = process.env.TRACKER_STORAGE_CONNECTION;
  if (!conn) throw new Error('TRACKER_STORAGE_CONNECTION application setting is not configured');
  return TableClient.fromConnectionString(conn, TABLE_NAME);
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

    let client;
    try {
      client = getClient();
      await client.createTable();
    } catch (e) {
      // table may already exist, or a real config error - only log
      context.log('createTable note:', e.message);
    }

    if (request.method === 'GET') {
      try {
        const entity = await client.getEntity(PARTITION_KEY, ROW_KEY);
        return { status: 200, jsonBody: JSON.parse(entity.json) };
      } catch (e) {
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
      await client.upsertEntity(
        {
          partitionKey: PARTITION_KEY,
          rowKey: ROW_KEY,
          json: JSON.stringify(body),
          updatedBy: principal.userDetails,
          updatedAt: new Date().toISOString()
        },
        'Replace'
      );
      return { status: 200, jsonBody: { ok: true } };
    }

    return { status: 405, jsonBody: { error: 'Method not allowed' } };
  }
});
