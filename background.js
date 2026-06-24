// SF Credit Monitor — background.js
// READ-ONLY: this extension never writes data to the Salesforce org.
//
// Auth flow (OAuth 2.0 JWT Bearer, per Salesforce Data 360 JWT guide):
//   Step 1: Sign a JWT with the private key → POST /services/oauth2/token
//           → Salesforce access token
//   Step 2: Exchange access token → POST /services/a360/token
//           → Data Cloud tenant token + TSE (tenant-specific endpoint)
//   Step 3: All Data Cloud queries use the tenant token against {TSE}/api/v2/query
//
// Required setup (one-time, in options page):
//   - Consumer Key from External Client App in Salesforce
//   - Salesforce username of the Data Cloud integration user
//   - Contents of Data360_privatekey.pem

const API_VERSION = 'v62.0';

// In-memory token cache — keyed by orgUrl
const tokenCache = {};

// ── Toolbar click ──────────────────────────────────────────────────────────

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

  if (message.type === 'testAuth') {
    testAuth(message.orgUrl)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
});

// ── URL helper ─────────────────────────────────────────────────────────────

function toApiUrl(orgUrl) {
  return orgUrl
    .replace(/\.lightning\.force\.com$/, '.my.salesforce.com')
    .replace(/\.visual\.force\.com$/, '.my.salesforce.com');
}

// ── Settings helpers ───────────────────────────────────────────────────────

async function getSettings() {
  const result = await chrome.storage.local.get(['consumerKey', 'username', 'privateKey', 'loginUrl']);
  if (!result.consumerKey || !result.username || !result.privateKey) {
    throw new Error('NOT_CONFIGURED: Open extension settings (right-click the icon → Options) and enter your Consumer Key, username, and private key.');
  }
  return {
    consumerKey: result.consumerKey.trim(),
    username:    result.username.trim(),
    privateKey:  result.privateKey.trim(),
    loginUrl:    (result.loginUrl || 'https://login.salesforce.com').trim(),
  };
}

// ── JWT signing (Web Crypto API — available in MV3 service workers) ────────

async function buildSignedJwt(consumerKey, username, privateKeyPem, loginUrl) {
  // Parse the PEM private key
  const pemBody = privateKeyPem
    .replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----/, '')
    .replace(/-----END (?:RSA )?PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256' };
  const payload = { iss: consumerKey, sub: username, aud: loginUrl, exp: now + 180 };

  const encode = obj => btoa(JSON.stringify(obj))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const signingInput = `${encode(header)}.${encode(payload)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return `${signingInput}.${sigB64}`;
}

// ── Step 1: JWT Bearer Flow → Salesforce access token ─────────────────────

async function getSalesforceToken(settings) {
  const jwt = await buildSignedJwt(
    settings.consumerKey, settings.username, settings.privateKey, settings.loginUrl
  );

  const res = await fetch(`${settings.loginUrl}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt
    })
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Salesforce JWT auth failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text);
  if (!json.access_token) throw new Error(`JWT auth: no access_token in response: ${text.slice(0, 200)}`);
  return json; // { access_token, instance_url, ... }
}

// ── Step 2: Token exchange → Data Cloud tenant token ──────────────────────

async function getDataCloudToken(orgUrl) {
  const cached = tokenCache[orgUrl];
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return { token: cached.token, tse: cached.tse };
  }

  const settings = await getSettings();
  const sfToken  = await getSalesforceToken(settings);
  const apiUrl   = sfToken.instance_url || toApiUrl(orgUrl);

  const res = await fetch(`${apiUrl}/services/a360/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:         'urn:salesforce:grant-type:external:cdp',
      subject_token:      sfToken.access_token,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token'
    })
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Data Cloud token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = JSON.parse(text);
  if (!json.access_token || !json.instance_url) {
    throw new Error(`Token exchange missing fields: ${text.slice(0, 200)}`);
  }

  const tse = json.instance_url.replace(/\/$/, '');
  const expiresIn = (json.expires_in || 7200) * 1000;
  tokenCache[orgUrl] = { token: json.access_token, tse, expiresAt: Date.now() + expiresIn };
  return { token: json.access_token, tse };
}

// ── Data Cloud query helper ────────────────────────────────────────────────

async function dcQuery(orgUrl, sql, retried = false) {
  const { token, tse } = await getDataCloudToken(orgUrl);

  const res = await fetch(`${tse}/api/v2/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({ sql })
  });

  if (res.status === 401 && !retried) {
    delete tokenCache[orgUrl];
    return dcQuery(orgUrl, sql, true);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 403 || res.status === 401) throw new Error('ACCESS_DENIED');
    throw new Error(`Data Cloud query failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return res.json();
}

// ── Test auth (used by options page) ──────────────────────────────────────

async function testAuth(orgUrl) {
  const { token, tse } = await getDataCloudToken(orgUrl);
  const res = await fetch(`${tse}/api/v1/metadata/`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Metadata check failed (${res.status})`);
  return { tse, status: res.status };
}

// ── Overview: entitlements + consumed totals ───────────────────────────────

async function fetchOverview(orgUrl) {
  const [entResp, consumedResp] = await Promise.all([
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
    dcQuery(orgUrl, `
      SELECT
        carddefinitiondevelopername__c AS CardDevName,
        SUM(unitsconsumed__c)          AS TotalConsumed
      FROM TenantDailyEntitlementConsumption
      GROUP BY carddefinitiondevelopername__c
    `)
  ]);

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

// ── Entitlements ───────────────────────────────────────────────────────────

async function fetchEntitlements(orgUrl) {
  return dcQuery(orgUrl, `
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
  `);
}

// ── Daily consumption ──────────────────────────────────────────────────────

async function fetchDailyConsumption(orgUrl, startDate, endDate) {
  return dcQuery(orgUrl, `
    SELECT
      CAST(utilizationdate__c AS DATE) AS UtilizationDate,
      carddefinitiondevelopername__c AS CardName,
      SUM(unitsconsumed__c) AS TotalUnitsConsumed
    FROM TenantDailyEntitlementConsumption
    WHERE utilizationdate__c >= '${startDate}T00:00:00Z'
      AND utilizationdate__c <= '${endDate}T23:59:59Z'
    GROUP BY CAST(utilizationdate__c AS DATE), carddefinitiondevelopername__c
    ORDER BY CAST(utilizationdate__c AS DATE) ASC
  `);
}

// ── Hourly consumption ─────────────────────────────────────────────────────

async function fetchHourlyConsumption(orgUrl, startDate, endDate) {
  return dcQuery(orgUrl, `
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
  `);
}

// ── Enriched usage breakdown ───────────────────────────────────────────────

async function fetchBreakdown(orgUrl, startDate, endDate, groupBy) {
  let selectCol, groupCol;
  if (groupBy === 'user') {
    selectCol = 'usagereportingorgid__c AS GroupValue';
    groupCol  = 'usagereportingorgid__c';
  } else if (groupBy === 'type') {
    selectCol = 'usagetypedevelopername__c AS GroupValue';
    groupCol  = 'usagetypedevelopername__c';
  } else {
    selectCol = 'usagesubtype0__c AS GroupValue, usagesubtype1__c AS SubGroupValue';
    groupCol  = 'usagesubtype0__c, usagesubtype1__c';
  }

  return dcQuery(orgUrl, `
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
  `);
}

// ── Metadata ───────────────────────────────────────────────────────────────

async function fetchDcMetadata(orgUrl) {
  const { token, tse } = await getDataCloudToken(orgUrl);
  const res = await fetch(`${tse}/api/v1/metadata/`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Metadata fetch failed (${res.status})`);
  return res.json();
}
