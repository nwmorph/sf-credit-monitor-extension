// SF Credit Monitor — main.js
// Rendering engine for credit cards, timeline charts, and breakdown tables.
// READ-ONLY: this extension never writes data to the Salesforce org.

const CARD_LABELS = {
  FlexCredits:           { name: 'Flex Credits',            unit: 'Credits' },
  DataServicesCredits:   { name: 'Data Services Credits',   unit: 'Credits' },
  DataStorageAllocation: { name: 'Data Storage Allocation', unit: 'GB' },
  EinsteinRequests:      { name: 'Einstein Requests',       unit: 'Requests' },
};

// ── Credit cards — Overview ────────────────────────────────────────────────

function renderCreditCards(cardsData) {
  const grid = document.getElementById('credit-cards-grid');
  grid.replaceChildren();

  const metaEl = document.getElementById('overview-meta');
  metaEl.textContent = `${cardsData.length} card${cardsData.length !== 1 ? 's' : ''}`;

  // Health summary chips above the grid
  const healthBar = document.createElement('div');
  healthBar.className = 'health-bar';
  cardsData.forEach(({ cardKey, usage }) => {
    if (!usage) return;
    const pct = usage.totalQuantity > 0 ? (usage.unitsConsumed / usage.totalQuantity) * 100 : 0;
    const cls = pct >= 80 ? 'red' : pct >= 50 ? 'amber' : 'green';
    const meta = CARD_LABELS[cardKey.developerName] || { name: cardKey.developerName, unit: '' };
    const chip = document.createElement('div');
    chip.className = `health-chip ${cls}`;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const label = document.createElement('span');
    label.textContent = `${meta.name}: ${Math.round(pct)}%`;
    chip.appendChild(dot);
    chip.appendChild(label);
    healthBar.appendChild(chip);
  });
  grid.appendChild(healthBar);

  cardsData.forEach(({ cardKey, usage }) => {
    grid.appendChild(buildCreditCard(cardKey, usage));
  });
}

function buildCreditCard(cardKey, usage) {
  const meta = CARD_LABELS[cardKey.developerName] || { name: cardKey.developerName, unit: '' };
  const consumed = usage ? usage.unitsConsumed || 0 : 0;
  const total = usage ? usage.totalQuantity || 0 : 0;
  const remaining = total - consumed;
  const pct = total > 0 ? (consumed / total) * 100 : 0;
  const pctRounded = Math.round(pct);

  const card = document.createElement('div');
  card.className = 'credit-card';

  // Header: name + badge
  const header = document.createElement('div');
  header.className = 'credit-card-header';
  const name = document.createElement('span');
  name.className = 'credit-card-name';
  name.textContent = meta.name;
  const badge = document.createElement('span');
  badge.className = 'credit-badge';
  badge.textContent = cardKey.usageModel === 'PrePurchase' ? 'Pre-purchased' : cardKey.usageModel || '';
  header.appendChild(name);
  header.appendChild(badge);
  card.appendChild(header);

  // Consumption line
  const consRow = document.createElement('div');
  consRow.className = 'credit-card-consumption';
  const consumedLabel = document.createElement('span');
  consumedLabel.className = 'consumed-label';
  consumedLabel.textContent = `${meta.unit} Consumed: ${fmt(consumed)} (${pctRounded}%)`;
  const remainingLabel = document.createElement('span');
  remainingLabel.className = 'remaining-label';
  remainingLabel.textContent = `${meta.unit} Remaining: ${fmt(remaining)} (${100 - pctRounded}%)`;
  consRow.appendChild(consumedLabel);
  consRow.appendChild(remainingLabel);
  card.appendChild(consRow);

  // Progress bar
  const track = document.createElement('div');
  track.className = 'credit-progress-track';
  const fill = document.createElement('div');
  fill.className = `credit-progress-fill${pct >= 80 ? ' pct-red' : pct >= 50 ? ' pct-amber' : ''}`;
  fill.style.width = `${Math.min(100, pct)}%`;
  track.appendChild(fill);
  card.appendChild(track);

  // Meta row: total, start date, end date, contract
  const metaRow = document.createElement('div');
  metaRow.className = 'credit-card-meta';
  const metaItems = [
    { label: `Total ${meta.unit}`, value: fmt(total) },
    { label: 'Start Date',         value: usage && usage.startDate ? fmtDate(usage.startDate) : '—' },
    { label: 'End Date',           value: usage && usage.endDate   ? fmtDate(usage.endDate)   : '—' },
    { label: 'Contract',           value: usage && usage.contractNumber ? usage.contractNumber : '—', isLink: true },
  ];
  metaItems.forEach(({ label, value, isLink }) => {
    const item = document.createElement('div');
    item.className = 'credit-meta-item';
    const lbl = document.createElement('div');
    lbl.className = 'credit-meta-label';
    lbl.textContent = label;
    const val = document.createElement('div');
    val.className = isLink ? 'credit-meta-value link' : 'credit-meta-value';
    val.textContent = value;
    item.appendChild(lbl);
    item.appendChild(val);
    metaRow.appendChild(item);
  });
  card.appendChild(metaRow);

  // "View Consumption Details" link → navigates to Breakdown tab filtered to this card
  const viewLink = document.createElement('div');
  viewLink.className = 'credit-card-link';
  viewLink.textContent = 'View Consumption Details →';
  viewLink.addEventListener('click', () => navigateTo('breakdown'));
  card.appendChild(viewLink);

  return card;
}

// ── Daily timeline chart ───────────────────────────────────────────────────

function renderDailyTimeline(data) {
  const el = document.getElementById('tab-timeline-daily');
  el.replaceChildren();

  if (!data || !data.data || data.data.length === 0) {
    const msg = document.createElement('p');
    msg.style.cssText = 'padding:20px;color:var(--muted);font-size:0.85rem;';
    msg.textContent = 'No daily consumption data found for this period.';
    el.appendChild(msg);
    return;
  }

  // Group rows by EntitlementName
  const byCard = {};
  data.data.forEach(row => {
    const key = row.EntitlementName || 'Unknown';
    if (!byCard[key]) byCard[key] = [];
    byCard[key].push(row);
  });

  // Stat cards: total consumed in period per card
  const statCards = document.createElement('div');
  statCards.className = 'stat-cards';
  Object.entries(byCard).forEach(([name, rows]) => {
    const total = rows.reduce((s, r) => s + (parseFloat(r.TotalConsumed) || 0), 0);
    const card = document.createElement('div');
    card.className = 'stat-card';
    const lbl = document.createElement('div');
    lbl.className = 'stat-card-label';
    lbl.textContent = name;
    const val = document.createElement('div');
    val.className = 'stat-card-value';
    val.textContent = fmt(total);
    card.appendChild(lbl);
    card.appendChild(val);
    statCards.appendChild(card);
  });
  el.appendChild(statCards);

  // One chart per card
  Object.entries(byCard).forEach(([name, rows]) => {
    rows.sort((a, b) => (a.DataDate > b.DataDate ? 1 : -1));
    const container = document.createElement('div');
    container.className = 'chart-container';
    const title = document.createElement('div');
    title.className = 'chart-title';
    title.textContent = 'Credits Consumed Per Day';
    const subtitle = document.createElement('div');
    subtitle.className = 'chart-subtitle';
    subtitle.textContent = name;
    container.appendChild(title);
    container.appendChild(subtitle);
    container.appendChild(buildBarChart(rows, 'DataDate', 'TotalConsumed'));
    el.appendChild(container);
  });
}

// ── Bar chart (SVG, no library) ────────────────────────────────────────────

function buildBarChart(rows, xField, yField) {
  const W = 760, H = 180, pad = { top: 10, right: 10, bottom: 40, left: 50 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const values = rows.map(r => parseFloat(r[yField]) || 0);
  const maxVal = Math.max(...values, 1);
  const barW = Math.max(2, plotW / rows.length - 2);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('class', 'chart-svg');

  // Y-axis labels
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + plotH - (i / 4) * plotH;
    const val = Math.round((maxVal * i) / 4);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', pad.left); line.setAttribute('x2', pad.left + plotW);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('stroke', 'var(--border)'); line.setAttribute('stroke-width', '0.5');
    svg.appendChild(line);
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', pad.left - 4); text.setAttribute('y', y + 3);
    text.setAttribute('text-anchor', 'end');
    text.setAttribute('class', 'chart-axis-label');
    text.textContent = fmt(val);
    svg.appendChild(text);
  }

  // Bars + X labels
  rows.forEach((row, i) => {
    const val = parseFloat(row[yField]) || 0;
    const barH = (val / maxVal) * plotH;
    const x = pad.left + i * (plotW / rows.length) + (plotW / rows.length - barW) / 2;
    const y = pad.top + plotH - barH;

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', x); rect.setAttribute('y', y);
    rect.setAttribute('width', barW); rect.setAttribute('height', Math.max(barH, 0));
    rect.setAttribute('fill', 'var(--accent)');
    rect.setAttribute('rx', '2');
    rect.setAttribute('class', 'chart-bar');

    // Tooltip via title
    const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    titleEl.textContent = `${row[xField]}: ${fmt(val)}`;
    rect.appendChild(titleEl);
    svg.appendChild(rect);

    // X-axis label (every Nth to avoid clutter)
    const step = Math.max(1, Math.ceil(rows.length / 20));
    if (i % step === 0) {
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', x + barW / 2);
      text.setAttribute('y', pad.top + plotH + 14);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('class', 'chart-axis-label');
      text.setAttribute('transform', `rotate(-45, ${x + barW / 2}, ${pad.top + plotH + 14})`);
      text.textContent = String(row[xField]).slice(5); // show MM-DD
      svg.appendChild(text);
    }
  });

  return svg;
}

// ── Breakdown table ────────────────────────────────────────────────────────

function renderBreakdownTable(data, groupBy) {
  const el = document.getElementById(`tab-breakdown-${groupBy}`);
  if (!el) return;
  el.replaceChildren();

  const colLabel = groupBy === 'user' ? 'User' : groupBy === 'type' ? 'Type' : 'Feature';

  if (!data || !data.data || data.data.length === 0) {
    const msg = document.createElement('p');
    msg.style.cssText = 'padding:20px;color:var(--muted);font-size:0.85rem;';
    msg.textContent = `No ${groupBy} breakdown data found for this period.`;
    el.appendChild(msg);
    return;
  }

  const rows = data.data;
  const totalCredits = rows.reduce((s, r) => s + (parseFloat(r.TotalConsumed) || 0), 0);

  // Summary stat
  const statCards = document.createElement('div');
  statCards.className = 'stat-cards';
  [
    { label: 'Total Consumed', value: fmt(totalCredits) },
    { label: `Distinct ${colLabel}s`, value: String(rows.length) },
  ].forEach(({ label, value }) => {
    const card = document.createElement('div');
    card.className = 'stat-card';
    const lbl = document.createElement('div');
    lbl.className = 'stat-card-label';
    lbl.textContent = label;
    const val = document.createElement('div');
    val.className = 'stat-card-value';
    val.textContent = value;
    card.appendChild(lbl);
    card.appendChild(val);
    statCards.appendChild(card);
  });
  el.appendChild(statCards);

  // Table
  const wrap = document.createElement('div');
  wrap.className = 'breakdown-table-wrap';
  const table = document.createElement('table');
  table.className = 'breakdown-table';

  // Header
  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  [colLabel, 'Units Consumed', 'Event Count', 'Credits Consumed'].forEach((h, i) => {
    const th = document.createElement('th');
    if (i > 0) th.className = 'col-right';
    th.textContent = h;
    th.dataset.col = i;
    th.addEventListener('click', () => sortTable(table, i, th));
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  rows.forEach(row => {
    const groupCol = groupBy === 'user' ? 'UserId'
      : groupBy === 'type'    ? 'UsageType'
      : 'FeatureName';

    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = row[groupCol] || '—';
    const tdUnits = document.createElement('td');
    tdUnits.className = 'col-right num-value';
    tdUnits.textContent = fmt(row.TotalConsumed);
    const tdCount = document.createElement('td');
    tdCount.className = 'col-right num-value';
    tdCount.textContent = fmt(row.EventCount);
    const tdCredits = document.createElement('td');
    tdCredits.className = 'col-right num-value credits-consumed-value';
    tdCredits.textContent = fmt(row.TotalConsumed);
    tr.appendChild(tdName);
    tr.appendChild(tdUnits);
    tr.appendChild(tdCount);
    tr.appendChild(tdCredits);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  el.appendChild(wrap);
}

// ── Table sort ─────────────────────────────────────────────────────────────

function sortTable(table, colIndex, clickedTh) {
  const tbody = table.querySelector('tbody');
  const rows = [...tbody.querySelectorAll('tr')];
  const asc = clickedTh.classList.contains('sort-asc');

  table.querySelectorAll('th').forEach(th => th.classList.remove('sort-asc', 'sort-desc'));
  clickedTh.classList.add(asc ? 'sort-desc' : 'sort-asc');

  rows.sort((a, b) => {
    const av = a.cells[colIndex].textContent.replace(/\s/g, '');
    const bv = b.cells[colIndex].textContent.replace(/\s/g, '');
    const an = parseFloat(av.replace(/[^0-9.-]/g, ''));
    const bn = parseFloat(bv.replace(/[^0-9.-]/g, ''));
    const cmp = !isNaN(an) && !isNaN(bn) ? an - bn : av.localeCompare(bv);
    return asc ? -cmp : cmp;
  });

  rows.forEach(r => tbody.appendChild(r));
}

// ── Formatting helpers ─────────────────────────────────────────────────────

function fmt(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '—';
  return Math.round(num).toLocaleString();
}

function fmtDate(val) {
  if (!val) return '—';
  // Handle epoch ms, ISO string, or date string
  const d = typeof val === 'number' ? new Date(val) : new Date(val);
  if (isNaN(d.getTime())) return String(val);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
