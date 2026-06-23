const API_VERSION = 'v62.0';

// In-memory token cache — keyed by orgUrl
const dcTokenCache = {};

// ── Toolbar click: open or focus the monitor tab ───────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  const monitorUrl = chrome.runtime.getURL('newtab/index.html');
  const existing = await chrome.tabs.query({ url: monitorUrl });
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: monitorUrl });
  }
  if (tab?.url) {
    try {
      const orgUrl = new URL(tab.url).origin;
      if (/salesforce\.com|force\.com/.test(orgUrl)) {
        await chrome.storage.session.set({ orgUrl });
      }
    } catch (_) {}
  }
});

// ── Message handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'orgDetected') return false;

  if (message.type === 'fetchOrgInfo') {
    fetchOrgInfo(message.orgUrl)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'fetchOverview') {
    fetchOverview(message.orgUrl)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'fetchEntitlements') {
    fetchEntitlements(message.orgUrl)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'fetchDailyConsumption') {
    fetchDailyConsumption(message.orgUrl, message.startDate, message.endDate)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'fetchHourlyConsumption') {
    fetchHourlyConsumption(message.orgUrl, message.startDate, message.endDate)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'fetchBreakdown') {
    fetchBreakdown(message.orgUrl, message.startDate, message.endDate, message.groupBy)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'fetchDcMetadata') {
    fetchDcMetadata(message.orgUrl)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ── Auth helpers ───────────────────────────────────────────────────────────

function toApiUrl(orgUrl) {
  return orgUrl
    .replace(/\.lightning\.force\.com$/, '.my.salesforce.com')
    .replace(/\.visual\.force\.com$/, '.my.salesforce.com');
}

async function getSessionToken(orgUrl) {
  // Try multiple URL forms — the sid cookie domain varies by org setup.
  // Lightning orgs (*.lightning.force.com) set the cookie on that domain;
  // the converted *.my.salesforce.com URL may not have it.
  const urls = [...new Set([orgUrl, toApiUrl(orgUrl)])];
  for (const url of urls) {
    const cookie = await chrome.cookies.get({ url, name: 'sid' });
    if (cookie) return cookie.value;
    const community = await chrome.cookies.get({ url, name: 'sidCommunity' });
    if (community) return community.value;
  }
  throw new Error('Not logged in to this Salesforce org, or session has expired. Please log in and try again.');
}

// Exchange a Salesforce session token for a Data Cloud (a360) access token.
// Returns { token, tse } where tse is the tenant-specific endpoint base URL.
async function getDataCloudToken(orgUrl) {
  const cached = dcTokenCache[orgUrl];
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return { token: cached.token, tse: cached.tse };
  }

  const sid = await getSessionToken(orgUrl);
  // Use the API URL (*.my.salesforce.com) for the token exchange endpoint —
  // /services/a360/token is served from the core org, not the Lightning domain.
  const apiUrl = toApiUrl(orgUrl);

  // Cookie values may be URL-encoded — decode before use
  const accessToken = decodeURIComponent(sid);

  console.debug('[SF Credit Monitor] token exchange →', apiUrl, '| sid prefix:', accessToken.slice(0, 20) + '…');

  const res = await fetch(`${apiUrl}/services/a360/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Bearer ${accessToken}`
    },
    body: new URLSearchParams({
      grant_type: 'urn:salesforce:grant-type:external:cdp',
      subject_token: accessToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token'
    })
  });

  // Always read body as text first — avoids JSON parse crash on HTML error pages
  const rawBody = await res.text();
  console.debug('[SF Credit Monitor] token exchange response:', res.status, rawBody.slice(0, 300));

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('ACCESS_DENIED');
    throw new Error(`Data Cloud token exchange failed (${res.status}): ${rawBody.slice(0, 300)}`);
  }

  let json;
  try {
    json = JSON.parse(rawBody);
  } catch (_) {
    throw new Error(`Token exchange returned non-JSON (${res.status}): ${rawBody.slice(0, 200)}`);
  }

  if (!json.access_token || !json.instance_url) {
    throw new Error(`Token exchange missing fields: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const tse = json.instance_url.replace(/\/$/, '');
  // Cache for the token's lifetime (default ~2 hours); fall back to 90 min
  const expiresIn = (json.expires_in || 7200) * 1000;
  dcTokenCache[orgUrl] = { token: json.access_token, tse, expiresAt: Date.now() + expiresIn };
  return { token: json.access_token, tse };
}

// ── Data Cloud query helper ────────────────────────────────────────────────

async function dcQuery(orgUrl, sql, retried = false) {
  let token, tse;
  try {
    ({ token, tse } = await getDataCloudToken(orgUrl));
  } catch (e) {
    throw e;
  }

  const res = await fetch(`${tse}/api/v2/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql })
  });

  if (res.status === 401 && !retried) {
    // Token expired — purge cache and retry once
    delete dcTokenCache[orgUrl];
    return dcQuery(orgUrl, sql, true);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 403 || res.status === 401) throw new Error('ACCESS_DENIED');
    throw new Error(`Data Cloud query failed (${res.status}): ${text}`);
  }

  return res.json();
}

// ── Aura helper (for Digital Wallet card data) ─────────────────────────────

async function auraAction(orgUrl, descriptor, params) {
  const sid = await getSessionToken(orgUrl);
  const apiUrl = toApiUrl(orgUrl);

  // We need the aura.context fwuid — fetch it from the page context via a
  // lightweight preload call, or use a known-stable placeholder and let Aura
  // update it in the response context.
  const body = new URLSearchParams({
    message: JSON.stringify({
      actions: [{
        id: '1;a',
        descriptor,
        callingDescriptor: 'UNKNOWN',
        params
      }]
    }),
    'aura.context': JSON.stringify({
      mode: 'PROD',
      app: 'one:one',
      fwuid: '',
      loaded: {},
      dn: [],
      globals: {},
      uad: true
    }),
    'aura.pageURI': '/lightning/n/standard-ConsumptionCards',
    'aura.token': sid
  });

  const res = await fetch(`${apiUrl}/aura`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error('ACCESS_DENIED');
    throw new Error(`Aura call failed (${res.status})`);
  }

  const json = await res.json();
  const action = json.actions && json.actions[0];
  if (!action || action.state !== 'SUCCESS') {
    const msg = (action && action.error && action.error[0] && action.error[0].message) || 'Aura action failed';
    throw new Error(msg);
  }
  return action.returnValue;
}

// ── Org info ───────────────────────────────────────────────────────────────

async function fetchOrgInfo(orgUrl) {
  const sid = await getSessionToken(orgUrl);
  const apiUrl = toApiUrl(orgUrl);
  const res = await fetch(`${apiUrl}/services/data/${API_VERSION}/`, {
    headers: { 'Authorization': `Bearer ${sid}` }
  });
  if (!res.ok) throw new Error('Could not fetch org info');
  return res.json();
}

// ── Digital Wallet card listing ────────────────────────────────────────────
// Returns an array of credit card objects from the Digital Wallet.
// NOTE: The exact Aura action descriptor for listing all cards needs to be
// confirmed during Phase 0 (network tab inspection). The fetchCardUsage
// descriptor is confirmed. The listing descriptor is a best-guess placeholder
// that should be validated before the Timeline and Breakdown tabs are built.

async function fetchCards(orgUrl) {
  // Phase 0 TODO: replace descriptor with confirmed action from Network tab.
  // For now, fall back to a direct REST query for entitlement data if available.
  try {
    const data = await auraAction(
      orgUrl,
      'serviceComponent://ui.digital.wallet.components.aura.controllers.DigitalWalletController/ACTION$getCards',
      { businessEnvType: 'Production' }
    );
    return data;
  } catch (e) {
    // If the listing action fails, return an empty array — fetchCardUsage
    // per known card key will still work for the Overview tab.
    return { cards: [] };
  }
}

// ── Card usage (confirmed from Network tab) ────────────────────────────────

async function fetchCardUsage(orgUrl, cardKey) {
  return auraAction(
    orgUrl,
    'serviceComponent://ui.digital.wallet.components.aura.controllers.DigitalWalletController/ACTION$fetchCardUsage',
    cardKey
  );
}

// ── Daily consumption from Data Cloud DLO ─────────────────────────────────
// Fields: carddefinitiondevelopername__c, utilizationdate__c, unitsconsumed__c
// utilizationdate__c is a DateTime — cast to DATE for daily grouping

async function fetchDailyConsumption(orgUrl, startDate, endDate) {
  const sql = `
    SELECT
      CAST(utilizationdate__c AS DATE) AS UtilizationDate,
      carddefinitiondevelopername__c AS CardName,
      SUM(unitsconsumed__c) AS TotalUnitsConsumed
    FROM TenantDailyEntitlementConsumption
    WHERE utilizationdate__c >= '${startDate}T00:00:00Z'
      AND utilizationdate__c <= '${endDate}T23:59:59Z'
    GROUP BY CAST(utilizationdate__c AS DATE), carddefinitiondevelopername__c
    ORDER BY CAST(utilizationdate__c AS DATE) ASC
  `;
  return dcQuery(orgUrl, sql);
}

// ── Hourly consumption from Data Cloud DLO ────────────────────────────────
// Fields: usagehourbucket__c, carddefinitiondevelopername__c, unitsconsumed__c
// rowdetail__c must equal 'PROCESSED' to exclude partial/reprocessed records

async function fetchHourlyConsumption(orgUrl, startDate, endDate) {
  const sql = `
    SELECT
      usagehourbucket__c AS UsageHour,
      carddefinitiondevelopername__c AS CardName,
      SUM(unitsconsumed__c) AS TotalUnitsConsumed
    FROM TenantHourlyEntitlementConsumption
    WHERE usagehourbucket__c >= '${startDate}T00:00:00Z'
      AND usagehourbucket__c <= '${endDate}T23:59:59Z'
      AND rowdetail__c = 'PROCESSED'
    GROUP BY usagehourbucket__c, carddefinitiondevelopername__c
    ORDER BY usagehourbucket__c ASC
  `;
  return dcQuery(orgUrl, sql);
}

// ── Enriched usage breakdown from TenantEnrichedUsageEvent ────────────────
// Recommended for reporting — no extra cost, no DMO mapping needed.
// Fields used:
//   featuredevelopername__c  — the feature/action (e.g. CustomAgentAction)
//   usagesubtype0__c         — top-level grouping (e.g. Sandbox, Custom Agent Action)
//   usagesubtype1__c         — sub-grouping (e.g. specific action name)
//   resourceidorapiname__c   — the specific resource (agent action API name)
//   carddefinitiondevelopername__c — which card (FlexCredits, etc.)
//   unitsconsumed__c         — credits consumed (post-multiplier)
//   usagevalue__c            — raw usage (pre-multiplier)
//   multiplier__c            — the multiplier applied
//   eventime__c              — event timestamp

async function fetchBreakdown(orgUrl, startDate, endDate, groupBy) {
  let selectCol, groupCol;
  if (groupBy === 'user') {
    selectCol = 'usagereportingorgid __c AS GroupValue';
    groupCol  = 'usagereportingorgid __c';
  } else if (groupBy === 'type') {
    selectCol = 'usagetypedevelopername__c AS GroupValue';
    groupCol  = 'usagetypedevelopername__c';
  } else {
    // feature: group by usagesubtype0 + usagesubtype1 to match the hierarchy
    // in the Digital Wallet drill-down (Environment → Action Type → Specific Action)
    selectCol = 'usagesubtype0__c AS GroupValue, usagesubtype1__c AS SubGroupValue';
    groupCol  = 'usagesubtype0__c, usagesubtype1__c';
  }

  const sql = `
    SELECT
      ${selectCol},
      carddefinitiondevelopername__c AS CardName,
      SUM(unitsconsumed__c) AS TotalUnitsConsumed,
      SUM(usagevalue__c) AS TotalRawUsage,
      AVG(multiplier__c) AS AvgMultiplier,
      COUNT(*) AS EventCount
    FROM TenantEnrichedUsageEvent
    WHERE eventime__c >= '${startDate}T00:00:00Z'
      AND eventime__c <= '${endDate}T23:59:59Z'
    GROUP BY ${groupCol}, carddefinitiondevelopername__c
    ORDER BY TotalUnitsConsumed DESC
    LIMIT 100
  `;
  return dcQuery(orgUrl, sql);
}

// ── Overview: entitlements + consumed totals — pure DLO, no Aura ──────────
// Fetches everything needed for the overview cards in two parallel queries.

async function fetchOverview(orgUrl) {
  const [entResp, consumedResp] = await Promise.all([
    // TenantEntitlementTransaction: what was purchased
    dcQuery(orgUrl, `
      SELECT
        entitlementcarddefdevlname__c AS CardDevName,
        SUM(quantity__c)              AS TotalQuantity,
        MIN(startdate__c)             AS StartDate,
        MAX(enddate__c)               AS EndDate,
        mgmtorgcontract__c            AS ContractId,
        usagemodel__c                 AS UsageModel
      FROM TenantEntitlementTransaction
      WHERE entitlementtransactiontype__c = 'New'
      GROUP BY entitlementcarddefdevlname__c, mgmtorgcontract__c, usagemodel__c
      ORDER BY TotalQuantity DESC
    `),
    // TenantDailyEntitlementConsumption: what was consumed (all time — no date filter)
    dcQuery(orgUrl, `
      SELECT
        carddefinitiondevelopername__c AS CardDevName,
        SUM(unitsconsumed__c)          AS TotalConsumed
      FROM TenantDailyEntitlementConsumption
      GROUP BY carddefinitiondevelopername__c
    `)
  ]);

  // Merge consumed totals into entitlement rows
  const consumedMap = {};
  (consumedResp.data || []).forEach(r => {
    consumedMap[r.CardDevName] = parseFloat(r.TotalConsumed) || 0;
  });

  return (entResp.data || []).map(r => ({
    ...r,
    TotalConsumed: consumedMap[r.CardDevName] || 0,
    TotalQuantity: parseFloat(r.TotalQuantity) || 0,
  }));
}

// ── Entitlement data (contract dates, total quantities, card names) ────────
// Kept for compatibility — fetchOverview is preferred.

async function fetchEntitlements(orgUrl) {
  const sql = `
    SELECT
      entitlementcarddefdevlname__c AS CardDevName,
      SUM(quantity__c) AS TotalQuantity,
      MIN(startdate__c) AS StartDate,
      MAX(enddate__c) AS EndDate,
      mgmtorgcontract__c AS ContractId,
      usagemodel__c AS UsageModel
    FROM TenantEntitlementTransaction
    WHERE entitlementtransactiontype__c = 'New'
    GROUP BY entitlementcarddefdevlname__c, mgmtorgcontract__c, usagemodel__c
    ORDER BY TotalQuantity DESC
  `;
  return dcQuery(orgUrl, sql);
}

// ── Metadata (Phase 0 helper — schema discovery) ───────────────────────────

async function fetchDcMetadata(orgUrl) {
  const { token, tse } = await getDataCloudToken(orgUrl);
  const res = await fetch(`${tse}/api/v1/metadata/`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Metadata fetch failed (${res.status})`);
  return res.json();
}
