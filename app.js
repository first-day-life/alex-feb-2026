/* ═══════════════════════════════════════════════════
   LP Explorer – app.js
   Reads a Google Sheet (published as CSV) and renders
   an interactive dashboard with iframe page preview.
   ═══════════════════════════════════════════════════ */

// ── Default sheet URL (7d daily data) ────────────────
const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRCpN6f4J91aFKu9PFdPyqkWxc_q96mYif3JyCY9zI2C4VmoNHULLTvpa-XDOS_fkV9cIn2_0RfYZ_E/pub?gid=1777172587&single=true&output=csv";

// ── Password gate ───────────────────────────────────
const PASSWORD = "fdparty";

(function initLockScreen() {
  const lockScreen = document.getElementById("lock-screen");
  const lockForm = document.getElementById("lock-form");
  const lockInput = document.getElementById("lock-input");
  const lockError = document.getElementById("lock-error");
  const app = document.getElementById("app");

  // If already authenticated this session, skip
  if (sessionStorage.getItem("lp-authed") === "1") {
    lockScreen.classList.add("hidden");
    app.classList.remove("hidden");
    return;
  }

  lockForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (lockInput.value === PASSWORD) {
      sessionStorage.setItem("lp-authed", "1");
      lockScreen.classList.add("hidden");
      app.classList.remove("hidden");
      loadData();
    } else {
      lockError.classList.remove("hidden");
      const card = document.querySelector(".lock-card");
      card.classList.remove("shake");
      void card.offsetWidth; // reflow to restart animation
      card.classList.add("shake");
      lockInput.value = "";
      lockInput.focus();
    }
  });
})();

// ── State ───────────────────────────────────────────
let rawRows = [];  // all daily rows from sheet
let pages = [];    // aggregated by landing page for selected date range
let activePage = null;
let selectedPages = []; // compare mode selections
let compareMode = false;
let lastFiltered = [];
let funnelView = "conversion"; // "conversion" or "dropoff"

// ── DOM refs ────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const sidebarEl = $("#sidebar");
const listEl = $("#page-list");
const searchEl = $("#search");
const sortEl = $("#sort-select");
const previewWrap = $("#preview-frame-wrap");
const frameUrl = $("#frame-url");
const frameExternal = $("#frame-external");
const settingsModal = $("#settings-modal");
const loadingOverlay = $("#loading-overlay");
const loadingMessage = $("#loading-message");
const compareBtn = $("#compare-btn");
const compareGrid = $("#compare-grid");
const dateStartEl = $("#date-start");
const dateEndEl = $("#date-end");

// ── Init ────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  loadSavedSettings();
  bindEvents();
  if (sessionStorage.getItem("lp-authed") === "1") {
    loadData();
  }
});

// ── Events ──────────────────────────────────────────
function bindEvents() {
  // Sidebar toggle
  $("#sidebar-toggle").addEventListener("click", () => {
    sidebarEl.classList.toggle("open");
    sidebarEl.classList.toggle("closed");
  });

  // Search
  searchEl.addEventListener("input", () => renderList());

  // Sort
  sortEl.addEventListener("change", () => renderList());

  // Compare mode toggle
  compareBtn.addEventListener("click", toggleCompareMode);

  // Date range
  dateStartEl.addEventListener("change", () => applyDateRange());
  dateEndEl.addEventListener("change", () => applyDateRange());

  // Settings
  $("#settings-btn").addEventListener("click", () => settingsModal.classList.remove("hidden"));
  $("#settings-cancel").addEventListener("click", () => settingsModal.classList.add("hidden"));
  $(".modal-backdrop").addEventListener("click", () => settingsModal.classList.add("hidden"));
  $("#settings-save").addEventListener("click", saveSettings);

  // Keyboard nav
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (compareMode) {
        toggleCompareMode();
      } else {
        settingsModal.classList.add("hidden");
      }
    }
    if (e.key === "/" && document.activeElement !== searchEl) {
      e.preventDefault();
      searchEl.focus();
    }
  });
}

// ── Compare mode ────────────────────────────────────
function toggleCompareMode() {
  compareMode = !compareMode;
  compareBtn.classList.toggle("active", compareMode);
  document.body.classList.toggle("compare-mode", compareMode);

  if (!compareMode) {
    selectedPages = [];
    // Restore single view if there was an active page
    if (activePage) {
      previewWrap.classList.remove("hidden");
      renderCompareGrid();
    } else {
      previewWrap.classList.add("hidden");
    }
  } else {
    // Enter compare mode: if a single page was active, seed it
    if (activePage) {
      selectedPages = [activePage];
    } else {
      selectedPages = [];
      previewWrap.classList.add("hidden");
    }
  }
  renderList();
  renderCompareGrid();
}

// ── Settings persistence ────────────────────────────
function loadSavedSettings() {
  const saved = localStorage.getItem("lp-explorer-settings");
  if (saved) {
    try {
      const s = JSON.parse(saved);
      $("#sheet-url").value = s.sheetUrl || DEFAULT_SHEET_URL;
      if (s.colUrl) $("#col-url").value = s.colUrl;
      if (s.colName) $("#col-name").value = s.colName;
      if (s.colCvr) $("#col-cvr").value = s.colCvr;
      if (s.colBounce) $("#col-bounce").value = s.colBounce;
      if (s.colSessions) $("#col-sessions").value = s.colSessions;
    } catch (_) {}
  } else {
    $("#sheet-url").value = DEFAULT_SHEET_URL;
  }
}

function saveSettings() {
  const settings = {
    sheetUrl: $("#sheet-url").value.trim(),
    colUrl: $("#col-url").value.trim(),
    colName: $("#col-name").value.trim(),
    colCvr: $("#col-cvr").value.trim(),
    colBounce: $("#col-bounce").value.trim(),
    colSessions: $("#col-sessions").value.trim(),
  };
  localStorage.setItem("lp-explorer-settings", JSON.stringify(settings));
  settingsModal.classList.add("hidden");
  loadData();
}

// ── Data loading ────────────────────────────────────
async function loadData() {
  setLoading(true, "Loading data from URL...");
  activePage = null;
  selectedPages = [];
  previewWrap.classList.add("hidden");

  const saved = localStorage.getItem("lp-explorer-settings");
  let sheetUrl = DEFAULT_SHEET_URL;
  let colMap = {
    day: "day",
    url: "landing_page_path",
    name: "landing_page_path",
    cvr: "conversion_rate",
    bounce: "bounce_rate",
    sessions: "sessions",
    addedToCart: "added_to_cart_rate",
    reachedCheckout: "reached_checkout_rate",
    completedCheckout: "completed_checkout_rate",
    sessionsCompleted: "sessions_that_completed_checkout",
  };

  if (saved) {
    try {
      const s = JSON.parse(saved);
      if (s.colUrl) colMap.url = s.colUrl;
      if (s.colName) colMap.name = s.colName;
      if (s.colCvr) colMap.cvr = s.colCvr;
      if (s.colBounce) colMap.bounce = s.colBounce;
      if (s.colSessions) colMap.sessions = s.colSessions;
    } catch (_) {}
  }

  try {
    if (!sheetUrl) throw new Error("Sheet URL is missing. Add it in Settings.");

    const requestUrl = withCacheBust(sheetUrl);
    const resp = await fetch(requestUrl, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const csv = await resp.text();
    rawRows = parseCSVRows(csv, colMap);

    // Set date range from data
    const dates = rawRows.map((r) => r.day).filter(Boolean).sort();
    if (dates.length) {
      const minDate = dates[0];
      const maxDate = dates[dates.length - 1];
      dateStartEl.min = minDate;
      dateStartEl.max = maxDate;
      dateEndEl.min = minDate;
      dateEndEl.max = maxDate;
      dateStartEl.value = minDate;
      dateEndEl.value = maxDate;
    }

    applyDateRange();
  } catch (err) {
    toast(`Error loading sheet: ${err.message}`);
    rawRows = [];
    pages = [];
  } finally {
    setLoading(false);
  }

  renderList();
}

// ── Date range aggregation ──────────────────────────
function applyDateRange() {
  const startDate = dateStartEl.value;
  const endDate = dateEndEl.value;

  // Filter rows by date range
  const filtered = rawRows.filter((r) => {
    if (!r.day) return true;
    return r.day >= startDate && r.day <= endDate;
  });

  // Aggregate by landing page path
  pages = aggregateByPage(filtered);

  const dayCount = new Set(filtered.map((r) => r.day).filter(Boolean)).size;
  toast(`Loaded ${pages.length} pages across ${dayCount} day${dayCount !== 1 ? "s" : ""}`);

  activePage = null;
  selectedPages = [];
  previewWrap.classList.add("hidden");
  renderList();
}

// ── CSV parser (returns raw daily rows) ─────────────
function parseCSVRows(text, colMap) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const idx = (key) => headers.findIndex((h) => h.toLowerCase() === colMap[key].toLowerCase());
  const idxDay = idx("day");
  const idxUrl = idx("url");
  const idxName = idx("name");
  const idxCvr = idx("cvr");
  const idxBounce = idx("bounce");
  const idxSessions = idx("sessions");
  const idxAddedToCart = idx("addedToCart");
  const idxReachedCheckout = idx("reachedCheckout");
  const idxCompletedCheckout = idx("completedCheckout");
  const idxSessionsCompleted = idx("sessionsCompleted");

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const day = idxDay >= 0 ? (cols[idxDay] || "").trim() : "";
    const path = idxUrl >= 0 ? (cols[idxUrl] || "").trim() : "";
    if (!path) continue;
    if (day && day.toLowerCase() === "day") continue;

    rows.push({
      day,
      path,
      name: idxName >= 0 ? (cols[idxName] || path).trim() : path,
      cvr: idxCvr >= 0 ? normalizeRate(parseNum(cols[idxCvr])) : 0,
      bounce: idxBounce >= 0 ? normalizeRate(parseNum(cols[idxBounce])) : 0,
      sessions: idxSessions >= 0 ? parseNum(cols[idxSessions]) : 0,
      addedToCartRate: idxAddedToCart >= 0 ? normalizeRate(parseNum(cols[idxAddedToCart])) : 0,
      reachedCheckoutRate: idxReachedCheckout >= 0 ? normalizeRate(parseNum(cols[idxReachedCheckout])) : 0,
      completedCheckoutRate: idxCompletedCheckout >= 0 ? normalizeRate(parseNum(cols[idxCompletedCheckout])) : 0,
      sessionsCompleted: idxSessionsCompleted >= 0 ? parseNum(cols[idxSessionsCompleted]) : 0,
    });
  }
  return rows;
}

function aggregateByPage(rows) {
  const map = new Map();
  for (const r of rows) {
    let agg = map.get(r.path);
    if (!agg) {
      agg = {
        path: r.path,
        name: r.name,
        sessions: 0,
        sessionsCompleted: 0,
        // weighted accumulators
        wCvr: 0, wBounce: 0, wAtc: 0, wReach: 0, wCompleted: 0,
      };
      map.set(r.path, agg);
    }
    agg.sessions += r.sessions;
    agg.sessionsCompleted += r.sessionsCompleted;
    agg.wCvr += r.cvr * r.sessions;
    agg.wBounce += r.bounce * r.sessions;
    agg.wAtc += r.addedToCartRate * r.sessions;
    agg.wReach += r.reachedCheckoutRate * r.sessions;
    agg.wCompleted += r.completedCheckoutRate * r.sessions;
  }

  const baseUrl = "https://firstday.com";
  return Array.from(map.values()).map((a) => {
    const s = a.sessions || 1;
    return {
      url: baseUrl + normalizePath(a.path),
      name: a.name,
      sessions: a.sessions,
      sessionsCompleted: a.sessionsCompleted,
      cvr: a.wCvr / s,
      bounce: a.wBounce / s,
      addedToCartRate: a.wAtc / s,
      reachedCheckoutRate: a.wReach / s,
      completedCheckoutRate: a.wCompleted / s,
    };
  });
}

function normalizePath(path) {
  if (!path) return "/";
  if (path[0] !== "/") return "/" + path;
  return path;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  result.push(current.trim());
  return result;
}

function parseNum(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/[%,]/g, "")) || 0;
}

function normalizeRate(v) {
  // Treat 0-1 values as fractions; convert to percent
  if (v > 0 && v <= 1) return v * 100;
  return v;
}

// ── Render list ─────────────────────────────────────
function renderList() {
  const query = searchEl.value.toLowerCase();
  const sortKey = sortEl.value;

  let filtered = pages.filter(
    (p) => p.name.toLowerCase().includes(query) || p.url.toLowerCase().includes(query)
  );

  const totals = aggregateForAverages(filtered);
  const avgCvr = totals.sessions ? totals.weightedCvr : 0;
  const avgBounce = totals.sessions ? totals.weightedBounce : 0;

  // Sort
  const [field, dir] = sortKey.split("-");
  filtered.sort((a, b) => {
    const va = field === "cvr" ? a.cvr : field === "bounce" ? a.bounce : a.sessions;
    const vb = field === "cvr" ? b.cvr : field === "bounce" ? b.bounce : b.sessions;
    return dir === "desc" ? vb - va : va - vb;
  });

  // Find max sessions for bar chart
  const maxSessions = Math.max(...filtered.map((p) => p.sessions), 1);

  listEl.innerHTML = "";
  lastFiltered = filtered;
  filtered.forEach((page, i) => {
    const isSelected = compareMode
      ? selectedPages.some((s) => s.url === page.url)
      : activePage && activePage.url === page.url;

    const li = document.createElement("li");
    li.className = `page-card${isSelected ? " active" : ""}`;
    if (compareMode) li.classList.add("compare-selectable");
    li.style.animationDelay = `${i * 40}ms`;

    const checkboxHtml = compareMode
      ? `<div class="page-card-checkbox ${isSelected ? "checked" : ""}">
           <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
         </div>`
      : "";

    li.innerHTML = `
      ${checkboxHtml}
      <div class="page-card-title">${esc(page.name)}</div>
      <div class="page-card-url">
        <span class="page-card-url-text">${esc(page.url)}</span>
        <button class="page-card-open" type="button" aria-label="Open page in new tab">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M6 2H3a1 1 0 00-1 1v8a1 1 0 001 1h8a1 1 0 001-1V8m-4-6h4m0 0v4m0-4L7 7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="page-card-metrics">
        <div class="metric">
          <span class="metric-value ${page.cvr >= avgCvr ? "good" : "bad"}">${page.cvr.toFixed(1)}%</span>
          <span class="metric-label">CVR</span>
        </div>
        <div class="metric">
          <span class="metric-value ${page.bounce <= avgBounce ? "good" : "bad"}">${page.bounce.toFixed(0)}%</span>
          <span class="metric-label">Bounce</span>
        </div>
        <div class="metric">
          <span class="metric-value">${fmtNum(page.sessions)}</span>
          <span class="metric-label">Sessions</span>
        </div>
      </div>
      <div class="page-card-bar">
        <div class="page-card-bar-fill" style="width:${(page.sessions / maxSessions) * 100}%;background:linear-gradient(90deg,var(--accent),var(--accent2))"></div>
      </div>
    `;

    li.addEventListener("click", () => {
      if (compareMode) {
        togglePageSelection(page);
      } else {
        selectPage(page, li);
      }
    });

    const openBtn = li.querySelector(".page-card-open");
    if (openBtn) {
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        window.open(page.url, "_blank", "noopener");
      });
    }
    listEl.appendChild(li);
  });

  updateSummary(filtered);
}

function togglePageSelection(page) {
  const idx = selectedPages.findIndex((s) => s.url === page.url);
  if (idx >= 0) {
    selectedPages.splice(idx, 1);
  } else {
    selectedPages.push(page);
  }

  if (selectedPages.length > 0) {
    previewWrap.classList.remove("hidden");
    // Update toolbar to show count
    frameUrl.textContent = `Comparing ${selectedPages.length} page${selectedPages.length > 1 ? "s" : ""}`;
    frameExternal.href = "#";
  } else {
    previewWrap.classList.add("hidden");
  }

  renderList();
  renderCompareGrid();
}

function selectPage(page, cardEl) {
  activePage = page;

  // Update active card
  document.querySelectorAll(".page-card").forEach((c) => c.classList.remove("active"));
  cardEl.classList.add("active");

  // Show funnel
  previewWrap.classList.remove("hidden");

  frameUrl.textContent = page.url;
  frameExternal.href = page.url;

  renderCompareGrid();

  // On mobile, close sidebar after selection
  if (window.innerWidth <= 768) {
    sidebarEl.classList.remove("open");
    sidebarEl.classList.add("closed");
  }
}

// ── Compare grid rendering ──────────────────────────

const FUNNEL_STEPS = [
  { key: "sessions", label: "Sessions" },
  { key: "engaged", label: "Engaged" },
  { key: "cart", label: "Added to Cart" },
  { key: "checkout", label: "Reached Checkout" },
  { key: "purchase", label: "Completed Purchase" },
];

function getStepData(page) {
  const sessions = page.sessions || 0;
  const engagedPct = clampRate(100 - (page.bounce || 0));
  const cartPct = clampRate(page.addedToCartRate || 0);
  const checkoutPct = clampRate(page.reachedCheckoutRate || 0);
  const purchasePct = clampRate(page.completedCheckoutRate || 0);
  const purchaseCount = page.sessionsCompleted > 0
    ? page.sessionsCompleted
    : Math.round(sessions * (purchasePct / 100));

  const steps = [
    { count: sessions, pctOfAll: 100 },
    { count: Math.round(sessions * engagedPct / 100), pctOfAll: engagedPct },
    { count: Math.round(sessions * cartPct / 100), pctOfAll: cartPct },
    { count: Math.round(sessions * checkoutPct / 100), pctOfAll: checkoutPct },
    { count: purchaseCount, pctOfAll: purchasePct },
  ];

  // Compute step conversion and drop-off (from previous step)
  for (let i = 0; i < steps.length; i++) {
    if (i === 0) {
      steps[i].stepConv = null;
      steps[i].dropoff = null;
      steps[i].dropCount = null;
    } else {
      const prev = steps[i - 1].count;
      steps[i].stepConv = prev > 0 ? (steps[i].count / prev) * 100 : 0;
      steps[i].dropoff = prev > 0 ? ((prev - steps[i].count) / prev) * 100 : 0;
      steps[i].dropCount = prev - steps[i].count;
    }
  }
  return steps;
}

function renderCompareGrid() {
  const pagesToRender = compareMode ? selectedPages : (activePage ? [activePage] : []);

  if (!pagesToRender.length) {
    compareGrid.innerHTML = "";
    return;
  }

  const allSteps = pagesToRender.map(getStepData);
  const isCompare = pagesToRender.length > 1;

  if (isCompare) {
    renderFunnelTable(pagesToRender, allSteps);
  } else {
    renderSingleFunnel(pagesToRender[0], allSteps[0]);
  }

  // Append summary stats table
  compareGrid.innerHTML += renderSummaryTable(pagesToRender);

  // Bind view toggle
  compareGrid.querySelectorAll(".ftable-view-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      funnelView = btn.dataset.view;
      renderCompareGrid();
    });
  });

  // Bind remove buttons
  compareGrid.querySelectorAll(".funnel-remove-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      selectedPages.splice(idx, 1);
      if (selectedPages.length === 0) previewWrap.classList.add("hidden");
      renderList();
      renderCompareGrid();
    });
  });
}

// ── Single page funnel ──────────────────────────────
function renderSingleFunnel(page, steps) {
  const isDropoff = funnelView === "dropoff";

  let html = `<div class="funnel-single">`;
  html += `<div class="funnel-single-header">
    <div class="funnel-page-name">${esc(page.name)}</div>
    <div class="funnel-page-url">${esc(page.url)}</div>
    <div class="funnel-kpis">
      <div class="funnel-kpi"><span class="funnel-kpi-value">${page.cvr.toFixed(1)}%</span><span class="funnel-kpi-label">CVR</span></div>
      <div class="funnel-kpi"><span class="funnel-kpi-value">${fmtNum(page.sessions)}</span><span class="funnel-kpi-label">Sessions</span></div>
      <div class="funnel-kpi"><span class="funnel-kpi-value">${fmtNum(steps[4].count)}</span><span class="funnel-kpi-label">Purchases</span></div>
    </div>
  </div>`;

  html += `<div class="ftable-toolbar">
    <div class="ftable-view-toggle">
      <button class="ftable-view-btn${!isDropoff ? " active" : ""}" data-view="conversion">Conversion</button>
      <button class="ftable-view-btn${isDropoff ? " active" : ""}" data-view="dropoff">Drop-off</button>
    </div>
    <div class="ftable-view-hint">${isDropoff ? "% lost at each step" : "% continuing to next step"}</div>
  </div>`;

  html += `<div class="funnel-flow">`;
  for (let i = 0; i < FUNNEL_STEPS.length; i++) {
    const step = steps[i];
    const barWidth = Math.max(3, step.pctOfAll);

    html += `<div class="funnel-flow-step">
      <div class="funnel-flow-step-main">
        <div class="funnel-flow-label">${FUNNEL_STEPS[i].label}</div>
        <div class="funnel-flow-values">
          <span class="funnel-flow-count">${fmtNum(step.count)}</span>
          <span class="funnel-flow-pct">${step.pctOfAll.toFixed(1)}%</span>
        </div>
      </div>
      <div class="funnel-flow-bar"><div class="funnel-flow-bar-fill" style="width:${barWidth}%"></div></div>`;

    // Arrow connector
    if (i < FUNNEL_STEPS.length - 1) {
      const next = steps[i + 1];
      if (isDropoff) {
        html += `<div class="funnel-flow-arrow funnel-flow-arrow-drop">
          <span class="funnel-flow-arrow-line"></span>
          <span class="funnel-flow-drop">${next.dropoff.toFixed(1)}% lost</span>
          <span class="funnel-flow-drop-count">${fmtNum(next.dropCount)}</span>
        </div>`;
      } else {
        html += `<div class="funnel-flow-arrow">
          <span class="funnel-flow-arrow-line"></span>
          <span class="funnel-flow-conv">${next.stepConv.toFixed(1)}%</span>
        </div>`;
      }
    }

    html += `</div>`;
  }
  html += `</div></div>`;

  compareGrid.className = "";
  compareGrid.innerHTML = html;
}

// ── Compare table funnel ────────────────────────────
function renderFunnelTable(pagesToRender, allSteps) {
  const baseSteps = allSteps[0];
  const colCount = pagesToRender.length;

  // Find biggest drop vs baseline
  let worstStepIdx = -1;
  let worstDelta = 0;
  if (colCount === 2) {
    for (let i = 1; i < FUNNEL_STEPS.length; i++) {
      const delta = allSteps[1][i].stepConv - baseSteps[i].stepConv;
      if (delta < worstDelta) {
        worstDelta = delta;
        worstStepIdx = i;
      }
    }
  }

  const hasDelta = colCount === 2;
  const isDropoff = funnelView === "dropoff";

  // View toggle
  let html = `<div class="ftable-toolbar">
    <div class="ftable-view-toggle">
      <button class="ftable-view-btn${!isDropoff ? " active" : ""}" data-view="conversion">Conversion</button>
      <button class="ftable-view-btn${isDropoff ? " active" : ""}" data-view="dropoff">Drop-off</button>
    </div>
    <div class="ftable-view-hint">${isDropoff ? "% lost at each step" : "% continuing to next step"}</div>
  </div>`;

  html += `<table class="ftable"><thead><tr>`;
  html += `<th class="ftable-step-label">Step</th>`;
  pagesToRender.forEach((page, idx) => {
    const removeBtn = compareMode ? `<button class="funnel-remove-btn" data-idx="${idx}">&times;</button>` : "";
    const badge = idx === 0 ? `<span class="funnel-baseline-badge">A</span>` : `<span class="funnel-compare-badge">B</span>`;
    html += `<th class="ftable-page-header">${badge} ${esc(page.name)} ${removeBtn}<div class="ftable-page-url">${esc(page.url)}</div></th>`;
  });
  if (hasDelta) html += `<th class="ftable-delta-header">Change</th>`;
  html += `</tr></thead><tbody>`;

  for (let i = 0; i < FUNNEL_STEPS.length; i++) {
    const isWorst = i === worstStepIdx;
    html += `<tr class="ftable-row${isWorst ? " ftable-row-worst" : ""}">`;
    html += `<td class="ftable-step-label">${FUNNEL_STEPS[i].label}${isWorst ? '<span class="ftable-worst-flag">Biggest gap</span>' : ""}</td>`;

    pagesToRender.forEach((_, idx) => {
      const step = allSteps[idx][i];
      const barWidth = Math.max(3, step.pctOfAll);
      const barColor = idx === 0 ? "var(--accent)" : "var(--accent2)";
      html += `<td class="ftable-cell">`;
      if (i === 0) {
        html += `<span class="ftable-count">${fmtNum(step.count)}</span>`;
      } else if (isDropoff) {
        html += `<span class="ftable-conv ftable-dropoff-val">${step.dropoff.toFixed(1)}%</span>`;
        html += `<span class="ftable-count-sub">${fmtNum(step.dropCount)} lost</span>`;
      } else {
        html += `<span class="ftable-conv">${step.stepConv.toFixed(1)}%</span>`;
        html += `<span class="ftable-count-sub">${fmtNum(step.count)} users</span>`;
      }
      html += `<div class="ftable-bar"><div class="ftable-bar-fill" style="width:${barWidth}%;background:${barColor}"></div></div>`;
      html += `</td>`;
    });

    if (hasDelta) {
      if (i > 0) {
        let a, b, higherIsBetter;
        if (isDropoff) {
          a = allSteps[0][i].dropoff;
          b = allSteps[1][i].dropoff;
          higherIsBetter = false; // lower drop-off is better
        } else {
          a = allSteps[0][i].stepConv;
          b = allSteps[1][i].stepConv;
          higherIsBetter = true;
        }
        const ppDiff = b - a;
        const sign = ppDiff > 0 ? "+" : "";
        const isGood = higherIsBetter ? ppDiff > 0 : ppDiff < 0;
        const cls = Math.abs(ppDiff) < 0.05 ? "diff-neutral" : (isGood ? "diff-good" : "diff-bad");
        const arrow = ppDiff > 0 ? "&#9650;" : ppDiff < 0 ? "&#9660;" : "";
        html += `<td class="ftable-cell ftable-delta"><span class="diff-badge ${cls}">${arrow} ${sign}${ppDiff.toFixed(1)}pp</span></td>`;
      } else {
        const diff = allSteps[1][0].count - allSteps[0][0].count;
        const sign = diff > 0 ? "+" : "";
        const cls = diff > 0 ? "diff-good" : diff < 0 ? "diff-bad" : "diff-neutral";
        html += `<td class="ftable-cell ftable-delta"><span class="diff-badge ${cls}">${sign}${fmtNum(diff)}</span></td>`;
      }
    }

    html += `</tr>`;
  }

  html += `</tbody></table>`;

  compareGrid.className = "";
  compareGrid.innerHTML = html;
}

// ── Summary stats table ─────────────────────────────
function renderSummaryTable(pagesToRender) {
  const hasDelta = pagesToRender.length === 2;

  const SUMMARY_ROWS = [
    { label: "Sessions", key: "sessions", fmt: "num", higher: true },
    { label: "Bounce Rate", key: "bounce", fmt: "pct", higher: false },
    { label: "Conversion Rate", key: "cvr", fmt: "pct", higher: true },
    { label: "% Added to Cart", key: "addedToCartRate", fmt: "pct", higher: true },
    { label: "% Reached Checkout", key: "reachedCheckoutRate", fmt: "pct", higher: true },
    { label: "% Checkout → Purchase", key: "_checkoutToPurchase", fmt: "pct", higher: true },
  ];

  // Compute derived metric
  function getVal(page, key) {
    if (key === "_checkoutToPurchase") {
      const sessions = page.sessions || 0;
      const reachedCount = Math.round(sessions * (page.reachedCheckoutRate || 0) / 100);
      const completedCount = page.sessionsCompleted > 0
        ? page.sessionsCompleted
        : Math.round(sessions * (page.completedCheckoutRate || 0) / 100);
      return reachedCount > 0 ? (completedCount / reachedCount) * 100 : 0;
    }
    return page[key] || 0;
  }

  let html = `<table class="ftable ftable-summary"><thead><tr>`;
  html += `<th class="ftable-step-label">Metric</th>`;
  pagesToRender.forEach((page, idx) => {
    const badge = pagesToRender.length > 1
      ? (idx === 0 ? `<span class="funnel-baseline-badge">A</span> ` : `<span class="funnel-compare-badge">B</span> `)
      : "";
    html += `<th class="ftable-page-header">${badge}${esc(page.name)}</th>`;
  });
  if (hasDelta) html += `<th class="ftable-delta-header">Change</th>`;
  html += `</tr></thead><tbody>`;

  for (const row of SUMMARY_ROWS) {
    html += `<tr class="ftable-row">`;
    html += `<td class="ftable-step-label">${row.label}</td>`;

    pagesToRender.forEach((page) => {
      const val = getVal(page, row.key);
      html += `<td class="ftable-cell">`;
      if (row.fmt === "num") {
        html += `<span class="ftable-count">${fmtNum(val)}</span>`;
      } else {
        html += `<span class="ftable-conv">${val.toFixed(1)}%</span>`;
      }
      html += `</td>`;
    });

    if (hasDelta) {
      const a = getVal(pagesToRender[0], row.key);
      const b = getVal(pagesToRender[1], row.key);
      if (row.fmt === "num") {
        const diff = b - a;
        const sign = diff > 0 ? "+" : "";
        const cls = diff === 0 ? "diff-neutral" : (row.higher ? (diff > 0 ? "diff-good" : "diff-bad") : (diff < 0 ? "diff-good" : "diff-bad"));
        html += `<td class="ftable-cell ftable-delta"><span class="diff-badge ${cls}">${sign}${fmtNum(diff)}</span></td>`;
      } else {
        const ppDiff = b - a;
        const sign = ppDiff > 0 ? "+" : "";
        const isGood = row.higher ? ppDiff > 0 : ppDiff < 0;
        const cls = Math.abs(ppDiff) < 0.05 ? "diff-neutral" : (isGood ? "diff-good" : "diff-bad");
        const arrow = ppDiff > 0 ? "&#9650;" : ppDiff < 0 ? "&#9660;" : "";
        html += `<td class="ftable-cell ftable-delta"><span class="diff-badge ${cls}">${arrow} ${sign}${ppDiff.toFixed(1)}pp</span></td>`;
      }
    }

    html += `</tr>`;
  }

  html += `</tbody></table>`;
  return html;
}

// Renders a diff badge showing absolute diff (pp) and relative % change
// higherIsBetter: true = green when positive, red when negative
// isAbsolute: true = compare raw numbers (sessions), false = compare percentages
function renderDiffBadge(value, baselineValue, higherIsBetter, isAbsolute) {
  const absDiff = value - baselineValue;
  const relDiff = baselineValue !== 0 ? ((value - baselineValue) / baselineValue) * 100 : 0;

  if (absDiff === 0 && relDiff === 0) {
    return `<span class="diff-badge diff-neutral">0</span>`;
  }

  const isPositive = absDiff > 0;
  const isGood = higherIsBetter ? isPositive : !isPositive;
  const colorClass = isGood ? "diff-good" : "diff-bad";
  const arrow = isPositive ? "&#9650;" : "&#9660;";
  const sign = isPositive ? "+" : "";

  if (isAbsolute) {
    // For absolute numbers (sessions, completed), show count diff + relative %
    return `<span class="diff-badge ${colorClass}">${arrow} ${sign}${fmtNum(Math.round(absDiff))} (${sign}${relDiff.toFixed(1)}%)</span>`;
  }

  // For percentages, show pp diff + relative %
  return `<span class="diff-badge ${colorClass}">${arrow} ${sign}${absDiff.toFixed(1)}pp (${sign}${relDiff.toFixed(1)}%)</span>`;
}

// ── Summary ─────────────────────────────────────────
function updateSummary(filtered) {
  $("#total-pages").textContent = filtered.length;
  const totalSess = filtered.reduce((s, p) => s + p.sessions, 0);
  const weightedCvr = totalSess
    ? filtered.reduce((s, p) => s + p.cvr * p.sessions, 0) / totalSess
    : 0;
  const weightedBounce = totalSess
    ? filtered.reduce((s, p) => s + p.bounce * p.sessions, 0) / totalSess
    : 0;
  $("#avg-cvr").textContent = weightedCvr.toFixed(1) + "%";
  $("#avg-bounce").textContent = weightedBounce.toFixed(1) + "%";
  $("#total-sessions").textContent = fmtNum(totalSess);
}

// ── Helpers ─────────────────────────────────────────
function aggregateForAverages(items) {
  if (!items.length) {
    return { sessions: 0, weightedCvr: 0, weightedBounce: 0 };
  }
  const sessions = items.reduce((s, p) => s + p.sessions, 0);
  const weightedCvr = sessions
    ? items.reduce((s, p) => s + p.cvr * p.sessions, 0) / sessions
    : 0;
  const weightedBounce = sessions
    ? items.reduce((s, p) => s + p.bounce * p.sessions, 0) / sessions
    : 0;
  return { sessions, weightedCvr, weightedBounce };
}
function fmtNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
}
function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

function clampRate(v) {
  if (Number.isNaN(v) || v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

function computeFunnelAverages(items) {
  if (!items || !items.length) {
    return { nonBouncePct: 0, addedPct: 0, reachedPct: 0, completedPct: 0 };
  }
  const sessions = items.reduce((s, p) => s + p.sessions, 0);
  if (!sessions) {
    return { nonBouncePct: 0, addedPct: 0, reachedPct: 0, completedPct: 0 };
  }
  const weighted = (fn) => items.reduce((s, p) => s + fn(p) * p.sessions, 0) / sessions;
  const nonBouncePct = weighted((p) => clampRate(100 - (p.bounce || 0)));
  const addedPct = weighted((p) => clampRate(p.addedToCartRate || 0));
  const reachedPct = weighted((p) => clampRate(p.reachedCheckoutRate || 0));
  const completedPct = weighted((p) => clampRate(p.completedCheckoutRate || 0));
  return { nonBouncePct, addedPct, reachedPct, completedPct };
}

// ── Toast ───────────────────────────────────────────
let toastTimer;
function toast(msg) {
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}

function setLoading(isLoading, msg = "Loading...") {
  if (!loadingOverlay) return;
  if (loadingMessage) loadingMessage.textContent = msg;
  loadingOverlay.classList.toggle("hidden", !isLoading);
}

function withCacheBust(url) {
  const ts = Date.now().toString();
  try {
    const u = new URL(url, window.location.href);
    u.searchParams.set("_ts", ts);
    return u.toString();
  } catch (_) {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}_ts=${ts}`;
  }
}
