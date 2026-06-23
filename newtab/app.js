// SF Credit Monitor — app.js
// Handles org detection, state, Chrome API glue, and section navigation.
// READ-ONLY: this extension never writes data to the Salesforce org.

let orgUrl = '';
let allCardsData = [];      // raw card objects from Digital Wallet
let dailyData = null;       // { rows, metadata } from TenantDailyEntitlementConsumption
let breakdownData = {};     // { feature, user, type } keyed by groupBy value
let activeSection = 'overview';
let dateRange = { start: '', end: '' };

const SF_PATTERN = /^https:\/\/[^/]+\.(salesforce\.com|force\.com|my\.salesforce\.com|lightning\.force\.com|sandbox\.my\.salesforce\.com|develop\.my\.salesforce\.com|scratch\.my\.salesforce\.com)/;

// ── Initialisation ─────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  setDefaultDateRange();
  setupNav();
  setupTabListeners();
  setupFilterListeners();
  await loadOrgUrl();
  await populateOrgSwitcher();
  updateOrgDisplay();
  if (orgUrl) doRefresh();
});

// ── Date range ─────────────────────────────────────────────────────────────

function setDefaultDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - 90);
  dateRange.end = end.toISOString().slice(0, 10);
  dateRange.start = start.toISOString().slice(0, 10);
  document.getElementById('filter-end').value = dateRange.end;
  document.getElementById('filter-start').value = dateRange.start;
}

function setupFilterListeners() {
  document.getElementById('filter-period').addEventListener('change', e => {
    const val = e.target.value;
    if (val === 'custom') return;
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - parseInt(val));
    dateRange.end = end.toISOString().slice(0, 10);
    dateRange.start = start.toISOString().slice(0, 10);
    document.getElementById('filter-end').value = dateRange.end;
    document.getElementById('filter-start').value = dateRange.start;
    dailyData = null;
    breakdownData = {};
  });

  document.getElementById('filter-start').addEventListener('change', e => {
    dateRange.start = e.target.value;
    document.getElementById('filter-period').value = 'custom';
    dailyData = null;
    breakdownData = {};
  });

  document.getElementById('filter-end').addEventListener('change', e => {
    dateRange.end = e.target.value;
    document.getElementById('filter-period').value = 'custom';
    dailyData = null;
    breakdownData = {};
  });

  document.getElementById('btn-refresh').addEventListener('click', () => doRefresh());

  document.getElementById('org-switcher').addEventListener('change', async e => {
    orgUrl = e.target.value;
    await chrome.storage.session.set({ orgUrl });
    allCardsData = [];
    dailyData = null;
    breakdownData = {};
    updateOrgDisplay();
    doRefresh();
  });
}

// ── Org detection ──────────────────────────────────────────────────────────

async function loadOrgUrl() {
  const result = await chrome.storage.session.get('orgUrl');
  if (result.orgUrl) { orgUrl = result.orgUrl; return; }
  const tabs = await chrome.tabs.query({});
  const sfTab = tabs.find(t => t.url && SF_PATTERN.test(t.url));
  if (sfTab) {
    orgUrl = new URL(sfTab.url).origin;
    await chrome.storage.session.set({ orgUrl });
  }
}

async function populateOrgSwitcher() {
  const tabs = await chrome.tabs.query({});
  const origins = [...new Set(
    tabs.filter(t => t.url && SF_PATTERN.test(t.url))
        .map(t => new URL(t.url).origin)
  )];

  const switcher = document.getElementById('org-switcher');
  switcher.innerHTML = '';
  origins.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o;
    opt.textContent = o.replace('https://', '');
    if (o === orgUrl) opt.selected = true;
    switcher.appendChild(opt);
  });
  switcher.style.display = origins.length > 1 ? '' : 'none';
  if (!orgUrl && origins.length > 0) orgUrl = origins[0];
}

function updateOrgDisplay() {
  const el = document.getElementById('sidebar-org');
  el.textContent = orgUrl ? orgUrl.replace('https://', '') : 'Not connected';
}

// ── Navigation ─────────────────────────────────────────────────────────────

function setupNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => navigateTo(item.dataset.section));
  });
}

function navigateTo(section) {
  activeSection = section;
  document.querySelectorAll('.nav-item').forEach(i => {
    i.classList.toggle('active', i.dataset.section === section);
  });
  document.querySelectorAll('.content-section').forEach(s => {
    s.style.display = s.id === `section-${section}` ? '' : 'none';
  });
  if (section === 'timeline' && !dailyData) loadTimeline();
  if (section === 'breakdown') loadBreakdown('feature');
}

function setupTabListeners() {
  document.addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    const tabGroup = btn.closest('.analysis-tabs');
    if (!tabGroup) return;
    tabGroup.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tabId = btn.dataset.tab;
    const panel = document.getElementById(`tab-${tabId}`);
    if (!panel) return;
    panel.closest('.content-section').querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    panel.classList.add('active');
    if (tabId === 'breakdown-user'  && !breakdownData.user)  loadBreakdown('user');
    if (tabId === 'breakdown-type'  && !breakdownData.type)  loadBreakdown('type');
    if (tabId === 'timeline-hourly' && !breakdownData.hourly) loadHourly();
  });
}

// ── Main refresh ───────────────────────────────────────────────────────────

async function doRefresh() {
  if (!orgUrl) { showEmpty('Open a Salesforce org tab, then click Refresh.'); return; }

  allCardsData = [];
  dailyData = null;
  breakdownData = {};
  showLoading('Loading Digital Wallet…');

  try {
    const r = await sendMsg({ type: 'fetchOverview', orgUrl });

    if (!r.ok) {
      const msg = r.error === 'ACCESS_DENIED'
        ? 'Access denied. Check that your user has permission to access Data Cloud APIs.'
        : `Error: ${r.error}`;
      showError(msg);
      return;
    }

    allCardsData = r.data;

    if (!allCardsData || allCardsData.length === 0) {
      showError('No credit card data found. Make sure Digital Wallet DLOs are set up in this org.');
      return;
    }

    showData();
    renderCreditCards(allCardsData);
    updateLastUpdated();
    navigateTo(activeSection);

  } catch (err) {
    showError(`Error: ${err.message}`);
  }
}

// ── Timeline ───────────────────────────────────────────────────────────────

async function loadTimeline() {
  const el = document.getElementById('tab-timeline-daily');
  setLoadingPanel(el);
  const r = await sendMsg({ type: 'fetchDailyConsumption', orgUrl, startDate: dateRange.start, endDate: dateRange.end });
  if (!r.ok) { setErrorPanel(el, r.error); return; }
  dailyData = r.data;
  renderDailyTimeline(dailyData);
}

async function loadHourly() {
  const el = document.getElementById('tab-timeline-hourly');
  setLoadingPanel(el);
  const r = await sendMsg({ type: 'fetchHourlyConsumption', orgUrl, startDate: dateRange.start, endDate: dateRange.end });
  if (!r.ok) { setErrorPanel(el, r.error); return; }
  breakdownData.hourly = r.data;
  renderHourlyTimeline(r.data);
}

// ── Breakdown ──────────────────────────────────────────────────────────────

async function loadBreakdown(groupBy = 'feature') {
  const el = document.getElementById(`tab-breakdown-${groupBy}`);
  if (!el) return;
  if (breakdownData[groupBy]) { renderBreakdownTable(breakdownData[groupBy], groupBy); return; }
  setLoadingPanel(el);
  const r = await sendMsg({ type: 'fetchBreakdown', orgUrl, startDate: dateRange.start, endDate: dateRange.end, groupBy });
  if (!r.ok) { setErrorPanel(el, r.error); return; }
  breakdownData[groupBy] = r.data;
  renderBreakdownTable(r.data, groupBy);
}

// ── UI state helpers ───────────────────────────────────────────────────────

function showEmpty(msg) {
  document.getElementById('main-empty').style.display = '';
  document.getElementById('main-empty').querySelector('p').textContent = msg;
  document.getElementById('main-loading').style.display = 'none';
  document.getElementById('main-error').style.display = 'none';
  document.getElementById('main-data').style.display = 'none';
}

function showLoading(msg) {
  document.getElementById('main-empty').style.display = 'none';
  document.getElementById('main-loading').style.display = '';
  document.getElementById('loading-msg').textContent = msg || 'Loading…';
  document.getElementById('main-error').style.display = 'none';
  document.getElementById('main-data').style.display = 'none';
}

function showError(msg) {
  document.getElementById('main-empty').style.display = 'none';
  document.getElementById('main-loading').style.display = 'none';
  const el = document.getElementById('main-error');
  el.style.display = '';
  el.textContent = msg;
  document.getElementById('main-data').style.display = 'none';
}

function showData() {
  document.getElementById('main-empty').style.display = 'none';
  document.getElementById('main-loading').style.display = 'none';
  document.getElementById('main-error').style.display = 'none';
  document.getElementById('main-data').style.display = '';
}

function setLoadingPanel(el) {
  const wrap = document.createElement('div');
  wrap.className = 'main-loading';
  wrap.style.height = '200px';
  const spinner = document.createElement('div');
  spinner.className = 'spinner';
  wrap.appendChild(spinner);
  el.replaceChildren(wrap);
}

function setErrorPanel(el, msg) {
  const div = document.createElement('div');
  div.className = 'main-error';
  div.textContent = msg;
  el.replaceChildren(div);
}

function updateLastUpdated() {
  const el = document.getElementById('sidebar-last-updated');
  el.textContent = `Refreshed: ${new Date().toLocaleTimeString()}`;
}

// ── Message helper ─────────────────────────────────────────────────────────

function sendMsg(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}
