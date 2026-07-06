/**
 * Budget Pacing Tracker — daily cost push
 *
 * Install this in EACH of the 4 Google Ads accounts (Electrical, Energy,
 * Antennas, Security), changing ACCOUNT_NAME each time to match exactly one
 * of the account names already set up in the tracker (check the tabs in
 * "Manage campaigns" for the exact spelling/apostrophe).
 *
 * Setup: Google Ads → Tools & Settings → Bulk Actions → Scripts → + New script
 * Paste this in, fill in the 3 CONFIG values below, run once to authorize,
 * then set it to run on a daily schedule (the "Frequency" option when you save).
 */

function main() {
  // ---- CONFIG: change these 3 lines per account ----
  var ACCOUNT_NAME = "Jim's Electrical";              // must match a tracker account name exactly
  var WEBHOOK_URL = 'https://REPLACE-WITH-YOUR-TRACKER-URL.azurestaticapps.net/api/ingest';
  var API_KEY = 'REPLACE-WITH-YOUR-INGEST-API-KEY';   // same value as the INGEST_API_KEY app setting
  // ----------------------------------------------------

  var query =
    "SELECT campaign.name, metrics.cost_micros " +
    "FROM campaign " +
    "WHERE segments.date DURING THIS_MONTH " +
    "AND campaign.status != 'REMOVED'";

  var rows = [];
  var report = AdsApp.report(query);
  var iterator = report.rows();
  while (iterator.hasNext()) {
    var row = iterator.next();
    var costMicros = Number(row['metrics.cost_micros']) || 0;
    rows.push({
      name: row['campaign.name'],
      cost: costMicros / 1000000
    });
  }

  var timeZone = AdsApp.currentAccount().getTimeZone();
  var dateStr = Utilities.formatDate(new Date(), timeZone, 'yyyy-MM-dd');

  var payload = {
    account: ACCOUNT_NAME,
    date: dateStr,
    rows: rows
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    headers: { 'x-api-key': API_KEY },
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(WEBHOOK_URL, options);
  Logger.log('Status: ' + response.getResponseCode());
  Logger.log(response.getContentText());
}
