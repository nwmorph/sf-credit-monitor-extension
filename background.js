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

  if (message.type === 'fetchCards') {
    fetchCards(message.orgUrl)
      .then(data => sendResponse({ ok: true, data }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'fetchCardUsage') {
    fetchCardUsage(message.orgUrl, message.cardKey)
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
  const url = toApiUrl(orgUrl);
  const cookie = await chrome.cookies.get({ url, name: 'sid' });
  if (cookie) return cookie.value;
  const fallback = await chrome.cookies.get({ url, name: 'sidCommunity' });
  if (fallback) return fallback.value;
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
  const apiUrl = toApiUrl(orgUrl);

  const res = await fetch(`${apiUrl}/services/a360/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:salesforce:grant-type:external:cdp',
      subject_token: sid,
      subject_token_type: 'urn:ietf:params:oauth:token-type:access_token'
    })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) throw new Error('ACCESS_DENIED');
    throw new Error(`Data Cloud token exchange failed (${res.status}): ${text}`);
  }

  const json = await res.json();
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

async function fetchDailyConsumption(orgUrl, startDate, endDate) {
  const sql = `
    SELECT
      DataDate,
      EntitlementName,
      SUM(ConsumedQuantity) AS TotalConsumed,
      SUM(RemainingQuantity) AS TotalRemaining,
      MAX(TotalQuantity) AS TotalQuantity
    FROM TenantDailyEntitlementConsumption
    WHERE DataDate >= '${startDate}' AND DataDate <= '${endDate}'
    GROUP BY DataDate, EntitlementName
    ORDER BY DataDate ASC
  `;
  return dcQuery(orgUrl, sql);
}

// ── Enriched usage breakdown from Data Cloud DLO ──────────────────────────

async function fetchBreakdown(orgUrl, startDate, endDate, groupBy) {
  // groupBy: 'feature' | 'user' | 'type'
  const groupCol = groupBy === 'user' ? 'UserId'
    : groupBy === 'type'    ? 'UsageType'
    : 'FeatureName';

  const sql = `
    SELECT
      ${groupCol},
      SUM(ConsumedQuantity) AS TotalConsumed,
      COUNT(*) AS EventCount
    FROM TenantEnrichedUsageEvent
    WHERE EventTime >= '${startDate}T00:00:00Z'
      AND EventTime <= '${endDate}T23:59:59Z'
    GROUP BY ${groupCol}
    ORDER BY TotalConsumed DESC
    LIMIT 50
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
