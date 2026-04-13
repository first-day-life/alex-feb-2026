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

// ── Shopify config ──────────────────────────────────
// Loaded from env.js (gitignored) at runtime.
// Create env.js with: window.__ENV = { SHOPIFY_DOMAIN: "...", SHOPIFY_TOKEN: "..." };
const DEFAULT_SHOPIFY_DOMAIN = (window.__ENV && window.__ENV.SHOPIFY_DOMAIN) || "";
const DEFAULT_SHOPIFY_TOKEN  = (window.__ENV && window.__ENV.SHOPIFY_TOKEN) || "";

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

  // Workbook hamburger menu (tab switcher)
  const wbBtn = $("#workbook-menu-btn");
  const wbMenu = $("#workbook-menu");
  wbBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowOpen = wbMenu.classList.toggle("hidden") === false;
    wbBtn.setAttribute("aria-expanded", nowOpen ? "true" : "false");
  });
  document.addEventListener("click", (e) => {
    if (!wbMenu.classList.contains("hidden") && !wbMenu.contains(e.target) && e.target !== wbBtn) {
      wbMenu.classList.add("hidden");
      wbBtn.setAttribute("aria-expanded", "false");
    }
  });
  wbMenu.querySelectorAll(".workbook-menu-item").forEach((item) => {
    item.addEventListener("click", () => {
      switchTab(item.dataset.tab);
      wbMenu.classList.add("hidden");
      wbBtn.setAttribute("aria-expanded", "false");
    });
  });

  // Facebook UTM refresh
  $("#fb-utm-refresh").addEventListener("click", loadFacebookUtmBreakdown);

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

  // UTM modal close
  $("#utm-modal-close").addEventListener("click", () => $("#utm-modal").classList.add("hidden"));
  $("#utm-modal .modal-backdrop").addEventListener("click", () => $("#utm-modal").classList.add("hidden"));

  // Keyboard nav
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const utmModal = $("#utm-modal");
      if (utmModal && !utmModal.classList.contains("hidden")) {
        utmModal.classList.add("hidden");
      } else if (compareMode) {
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
  let s = {};
  if (saved) {
    try { s = JSON.parse(saved); } catch (_) {}
  }

  $("#sheet-url").value = s.sheetUrl || DEFAULT_SHEET_URL;
  if (s.colUrl) $("#col-url").value = s.colUrl;
  if (s.colName) $("#col-name").value = s.colName;
  if (s.colCvr) $("#col-cvr").value = s.colCvr;
  if (s.colBounce) $("#col-bounce").value = s.colBounce;
  if (s.colSessions) $("#col-sessions").value = s.colSessions;
  $("#shopify-domain").value = s.shopifyDomain || DEFAULT_SHOPIFY_DOMAIN;
  $("#shopify-token").value = s.shopifyToken || DEFAULT_SHOPIFY_TOKEN;
}

function saveSettings() {
  const settings = {
    sheetUrl: $("#sheet-url").value.trim(),
    colUrl: $("#col-url").value.trim(),
    colName: $("#col-name").value.trim(),
    colCvr: $("#col-cvr").value.trim(),
    colBounce: $("#col-bounce").value.trim(),
    colSessions: $("#col-sessions").value.trim(),
    shopifyDomain: $("#shopify-domain").value.trim(),
    shopifyToken: $("#shopify-token").value.trim(),
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
        <div class="metric">
          <span class="metric-value">${fmtNum(page.sessionsCompleted)}</span>
          <span class="metric-label">Orders</span>
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

  // Bind diagnose CVR button
  const diagnoseBtn = compareGrid.querySelector("#diagnose-cvr-btn");
  if (diagnoseBtn) {
    diagnoseBtn.addEventListener("click", () => openUtmDiagnosis(pagesToRender[0]));
  }
}

// ── Single page funnel ──────────────────────────────
function renderSingleFunnel(page, steps) {
  const isDropoff = funnelView === "dropoff";

  let html = `<div class="funnel-single">`;

  // Full-width header
  html += `<div class="funnel-single-header">
    <div class="funnel-page-name">${esc(page.name)}</div>
    <div class="funnel-page-url">${esc(page.url)}</div>
    <div class="funnel-kpis">
      <div class="funnel-kpi"><span class="funnel-kpi-value">${page.cvr.toFixed(1)}%</span><span class="funnel-kpi-label">CVR</span></div>
      <div class="funnel-kpi"><span class="funnel-kpi-value">${fmtNum(page.sessions)}</span><span class="funnel-kpi-label">Sessions</span></div>
      <div class="funnel-kpi"><span class="funnel-kpi-value">${fmtNum(steps[4].count)}</span><span class="funnel-kpi-label">Purchases</span></div>
    </div>
    <button class="btn btn-diagnose" id="diagnose-cvr-btn">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="6" cy="6" r="4.5" stroke="currentColor" stroke-width="1.3"/><path d="M9.5 9.5L13 13" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      Diagnose CVR by UTM
    </button>
  </div>`;

  // Two-column body: funnel left, chart right
  html += `<div class="funnel-single-body">`;

  // Left column: funnel
  html += `<div class="funnel-single-left">`;
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
  html += `</div>`;
  html += `</div>`; // end funnel-single-left

  // Right column: chart
  html += `<div class="funnel-single-right">
    <div class="sessions-cvr-chart-wrap">
      <div class="sessions-cvr-chart-title">Sessions &amp; CVR Over Time</div>
      <canvas id="sessions-cvr-canvas"></canvas>
    </div>
  </div>`;

  html += `</div>`; // end funnel-single-body
  html += `</div>`; // end funnel-single

  compareGrid.className = "";
  compareGrid.innerHTML = html;

  // Draw the chart after DOM is ready
  requestAnimationFrame(() => drawSessionsCvrChart(page));
}

// ── Sessions & CVR dual-axis chart ─────────────────
function getDailyDataForPage(page) {
  const startDate = dateStartEl.value;
  const endDate = dateEndEl.value;
  const pagePath = normalizePath(page.url.replace("https://firstday.com", ""));

  return rawRows
    .filter((r) => {
      if (normalizePath(r.path) !== pagePath) return false;
      if (!r.day) return true;
      return r.day >= startDate && r.day <= endDate;
    })
    .sort((a, b) => (a.day > b.day ? 1 : -1));
}

function drawSessionsCvrChart(page) {
  const canvas = document.getElementById("sessions-cvr-canvas");
  if (!canvas) return;

  const dailyData = getDailyDataForPage(page);
  if (dailyData.length < 2) {
    canvas.parentElement.querySelector(".sessions-cvr-chart-title").textContent =
      "Sessions & CVR Over Time (not enough data)";
    canvas.style.display = "none";
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.floor(rect.width);
  const H = Math.floor(rect.height);
  canvas.width = W * dpr;
  canvas.height = H * dpr;

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const pad = { top: 16, right: 52, bottom: 44, left: 52 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  const sessions = dailyData.map((d) => d.sessions);
  const cvrs = dailyData.map((d) => d.cvr);
  const labels = dailyData.map((d) => d.day);

  const maxSess = Math.max(...sessions, 1);
  const maxCvr = Math.max(...cvrs, 0.1);

  // Nice round max for sessions axis
  const sessStep = Math.pow(10, Math.floor(Math.log10(maxSess || 1)));
  const sessMax = Math.ceil(maxSess / sessStep) * sessStep;
  const cvrMax = Math.ceil(maxCvr * 2) / 2; // round up to nearest 0.5

  const n = dailyData.length;
  const barW = Math.max(2, Math.min(24, (cw / n) * 0.6));
  const gap = cw / n;

  // Grid lines
  ctx.strokeStyle = "#2d3148";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (ch / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(W - pad.right, y);
    ctx.stroke();
  }

  // Session bars
  const accentColor = "#6c5ce7";
  const cvrColor = "#f59e0b";

  for (let i = 0; i < n; i++) {
    const x = pad.left + gap * i + gap / 2;
    const barH = (sessions[i] / sessMax) * ch;
    ctx.fillStyle = accentColor + "99";
    ctx.beginPath();
    const r = Math.min(3, barW / 2);
    const bx = x - barW / 2;
    const by = pad.top + ch - barH;
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + barW - r, by);
    ctx.quadraticCurveTo(bx + barW, by, bx + barW, by + r);
    ctx.lineTo(bx + barW, pad.top + ch);
    ctx.lineTo(bx, pad.top + ch);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.fill();
  }

  // CVR line
  ctx.strokeStyle = cvrColor;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = pad.left + gap * i + gap / 2;
    const y = pad.top + ch - (cvrs[i] / cvrMax) * ch;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // CVR dots
  ctx.fillStyle = cvrColor;
  for (let i = 0; i < n; i++) {
    const x = pad.left + gap * i + gap / 2;
    const y = pad.top + ch - (cvrs[i] / cvrMax) * ch;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Left axis labels (Sessions)
  ctx.fillStyle = "#9ca0b8";
  ctx.font = "10px Inter, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const val = sessMax - (sessMax / 4) * i;
    const y = pad.top + (ch / 4) * i;
    ctx.fillText(fmtNum(Math.round(val)), pad.left - 8, y);
  }

  // Right axis labels (CVR)
  ctx.fillStyle = cvrColor;
  ctx.textAlign = "left";
  for (let i = 0; i <= 4; i++) {
    const val = cvrMax - (cvrMax / 4) * i;
    const y = pad.top + (ch / 4) * i;
    ctx.fillText(val.toFixed(1) + "%", W - pad.right + 8, y);
  }

  // X-axis date labels (show subset to avoid crowding)
  ctx.fillStyle = "#9ca0b8";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const maxLabels = Math.floor(cw / 60);
  const step = Math.max(1, Math.ceil(n / maxLabels));
  for (let i = 0; i < n; i += step) {
    const x = pad.left + gap * i + gap / 2;
    const lbl = labels[i].length > 5 ? labels[i].slice(5) : labels[i]; // show MM-DD
    ctx.fillText(lbl, x, pad.top + ch + 6);
  }

  // Axis titles (rotated Y-axis labels)
  ctx.font = "600 10px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Left Y-axis: "Sessions"
  ctx.save();
  ctx.translate(12, pad.top + ch / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = accentColor;
  ctx.fillText("Sessions", 0, 0);
  ctx.restore();

  // Right Y-axis: "CVR %"
  ctx.save();
  ctx.translate(W - 12, pad.top + ch / 2);
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = cvrColor;
  ctx.fillText("CVR %", 0, 0);
  ctx.restore();
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
  const totalOrders = filtered.reduce((s, p) => s + p.sessionsCompleted, 0);
  $("#total-orders").textContent = fmtNum(totalOrders);
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

// ── UTM Diagnosis via Shopify ShopifyQL (proxied) ──

function getShopifyCredentials() {
  let domain = DEFAULT_SHOPIFY_DOMAIN;
  let token = DEFAULT_SHOPIFY_TOKEN;

  // localStorage overrides hardcoded defaults
  const saved = localStorage.getItem("lp-explorer-settings");
  if (saved) {
    try {
      const s = JSON.parse(saved);
      if (s.shopifyDomain) domain = s.shopifyDomain;
      if (s.shopifyToken) token = s.shopifyToken;
    } catch (_) {}
  }

  if (!domain || !token) return null;
  domain = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return { domain, token };
}

async function executeShopifyQL(query) {
  const resp = await fetch("/api/shopify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!resp.ok) {
    const errBody = await resp.json().catch(() => ({}));
    console.error("[ShopifyQL] API error:", JSON.stringify(errBody, null, 2));
    const debugStr = errBody.debug ? `\n\nDebug info:\n${JSON.stringify(errBody.debug, null, 2)}` : "";
    if (resp.status === 401) throw new Error(`Authentication failed (HTTP 401)${debugStr}`);
    if (resp.status === 403) throw new Error(`Access denied (HTTP 403)${debugStr}`);
    throw new Error((errBody.error || `Shopify returned HTTP ${resp.status}`) + debugStr);
  }

  const json = await resp.json();

  if (json.errors && json.errors.length) {
    throw new Error(`GraphQL error: ${json.errors.map((e) => e.message).join("; ")}`);
  }

  const payload = json.data?.shopifyqlQuery;
  if (!payload) throw new Error("Missing data.shopifyqlQuery in response");

  if (payload.parseErrors && payload.parseErrors.length) {
    throw new Error(`ShopifyQL parse error: ${JSON.stringify(payload.parseErrors)}`);
  }

  const tableData = payload.tableData;
  if (!tableData) throw new Error("Missing tableData in response");

  const columns = (tableData.columns || []).map((c) => c.name);
  const rows = (tableData.rows || []).map((row) => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = row[col] !== undefined ? row[col] : (Array.isArray(row) ? row[i] : "");
    });
    return obj;
  });

  return { columns, rows };
}

async function openUtmDiagnosis(page) {
  const modal = $("#utm-modal");
  const desc = $("#utm-modal-desc");
  const body = $("#utm-modal-body");

  modal.classList.remove("hidden");
  desc.textContent = `Analyzing: ${page.name}`;
  body.innerHTML = `<div class="utm-loading"><div class="utm-spinner"></div>Running ShopifyQL queries...</div>`;

  if (!getShopifyCredentials()) {
    body.innerHTML = `<div class="utm-empty">
      <p>Shopify API not configured.</p>
      <p>Set <code>SHOPIFY_URL</code> and <code>SHOPIFY_TOKEN</code> in Vercel env vars, or enter them manually in <strong>Settings</strong>.</p>
    </div>`;
    return;
  }

  const pagePath = normalizePath(page.url.replace("https://firstday.com", ""));
  const startDate = dateStartEl.value;
  const endDate = dateEndEl.value;

  // Compute previous period (same length, immediately before current range)
  const startMs = new Date(startDate).getTime();
  const endMs = new Date(endDate).getTime();
  const periodLen = endMs - startMs;
  const prevEnd = new Date(startMs - 86400000); // day before current start
  const prevStart = new Date(prevEnd.getTime() - periodLen);
  const prevStartDate = prevStart.toISOString().slice(0, 10);
  const prevEndDate = prevEnd.toISOString().slice(0, 10);

  try {
    const makeSessionsQuery = (since, until) => `
      FROM sessions
      SINCE ${since}
      UNTIL ${until}
      SHOW sessions, sessions_that_completed_checkout, conversion_rate,
           utm_source, utm_medium
      WHERE landing_page_path = '${pagePath}'
      GROUP BY utm_source, utm_medium
      ORDER BY sessions DESC
    `;
    const makeTotalsQuery = (since, until) => `
      FROM sessions
      SINCE ${since}
      UNTIL ${until}
      SHOW sessions, sessions_that_completed_checkout, conversion_rate
      WHERE landing_page_path = '${pagePath}'
    `;

    body.innerHTML = `<div class="utm-loading"><div class="utm-spinner"></div>Querying current &amp; previous period...</div>`;

    // Run current and previous period queries in parallel
    const [sessionsResult, totalsResult, prevSessionsResult, prevTotalsResult] = await Promise.all([
      executeShopifyQL(makeSessionsQuery(startDate, endDate)),
      executeShopifyQL(makeTotalsQuery(startDate, endDate)),
      executeShopifyQL(makeSessionsQuery(prevStartDate, prevEndDate)),
      executeShopifyQL(makeTotalsQuery(prevStartDate, prevEndDate)),
    ]);

    const analysis = buildUtmAnalysis(sessionsResult, totalsResult);
    const prevAnalysis = buildUtmAnalysis(prevSessionsResult, prevTotalsResult);
    renderUtmAnalysis(body, analysis, prevAnalysis, { startDate, endDate, prevStartDate, prevEndDate });
  } catch (err) {
    body.innerHTML = `<div class="utm-empty">
      <p>Error querying Shopify:</p>
      <p style="color:var(--red)">${esc(err.message).replace(/\n/g, "<br>")}</p>
      <p style="margin-top:8px;font-size:12px;color:var(--text2)">Check your store domain and access token in Settings.<br>The token needs <code>read_analytics</code> scope for ShopifyQL queries.</p>
      <details style="margin-top:10px;font-size:11px;color:var(--text2);text-align:left">
        <summary style="cursor:pointer">Full error details</summary>
        <pre style="margin-top:6px;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;background:rgba(0,0,0,.3);padding:8px;border-radius:4px">${esc(err.stack || err.message)}</pre>
      </details>
    </div>`;
  }
}

// ── Workbook tabs ───────────────────────────────────
function switchTab(tabId) {
  const mainEl = document.getElementById("main");
  const fbEl = document.getElementById("facebook-utm-view");

  document.querySelectorAll(".workbook-menu-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.tab === tabId);
  });

  if (tabId === "facebook-utm") {
    mainEl.classList.add("hidden");
    fbEl.classList.remove("hidden");
    const body = document.getElementById("fb-utm-body");
    // Auto-load on first visit
    if (body && body.dataset.loaded !== "1") {
      loadFacebookUtmBreakdown();
    }
  } else {
    fbEl.classList.add("hidden");
    mainEl.classList.remove("hidden");
  }
}

// ── Facebook UTM breakdown ──────────────────────────
async function loadFacebookUtmBreakdown() {
  const body = document.getElementById("fb-utm-body");
  body.innerHTML = `<div class="utm-loading"><div class="utm-spinner"></div>Querying Shopify for Facebook traffic...</div>`;

  if (!getShopifyCredentials()) {
    body.innerHTML = `<div class="fb-utm-empty">
      <p>Shopify API not configured.</p>
      <p>Set <code>SHOPIFY_DOMAIN</code> and <code>SHOPIFY_TOKEN</code> in env vars, or enter them in <strong>Settings</strong>.</p>
    </div>`;
    return;
  }

  const startDate = dateStartEl.value;
  const endDate = dateEndEl.value;

  // Break down Facebook traffic by landing page.
  // ShopifyQL fields (all part of the `sessions` table):
  //   sessions, bounce_rate, average_session_duration, added_to_cart_rate, conversion_rate
  const query = `
    FROM sessions
    SINCE ${startDate}
    UNTIL ${endDate}
    SHOW sessions, bounce_rate, average_session_duration, added_to_cart_rate,
         conversion_rate, landing_page_path
    WHERE utm_source = 'facebook'
    GROUP BY landing_page_path
    ORDER BY sessions DESC
  `;

  try {
    const result = await executeShopifyQL(query);
    renderFacebookUtmTable(body, result, { startDate, endDate });
    body.dataset.loaded = "1";
  } catch (err) {
    body.innerHTML = `<div class="fb-utm-empty">
      <p>Error querying Shopify:</p>
      <p style="color:var(--red)">${esc(err.message).replace(/\n/g, "<br>")}</p>
      <details style="margin-top:10px;font-size:11px;color:var(--text2);text-align:left">
        <summary style="cursor:pointer">Full error details</summary>
        <pre style="margin-top:6px;white-space:pre-wrap;word-break:break-all;max-height:300px;overflow:auto;background:rgba(0,0,0,.3);padding:8px;border-radius:4px">${esc(err.stack || err.message)}</pre>
      </details>
    </div>`;
  }
}

function renderFacebookUtmTable(container, result, dates) {
  const rows = (result.rows || []).map((r) => ({
    path: r.landing_page_path || "(unknown)",
    sessions: coerceNum(r.sessions),
    bounce: coerceNum(r.bounce_rate),
    duration: coerceNum(r.average_session_duration),
    cartRate: coerceNum(r.added_to_cart_rate),
    cvr: coerceNum(r.conversion_rate),
  }));

  if (!rows.length) {
    container.innerHTML = `<div class="fb-utm-empty">No Facebook sessions in ${dates.startDate} → ${dates.endDate}.</div>`;
    return;
  }

  // Totals / weighted averages
  const totalSessions = rows.reduce((a, r) => a + r.sessions, 0);
  const wAvg = (key) =>
    totalSessions > 0
      ? rows.reduce((a, r) => a + r[key] * r.sessions, 0) / totalSessions
      : 0;
  const avgBounce = wAvg("bounce");
  const avgDuration = wAvg("duration");
  const avgCart = wAvg("cartRate");
  const avgCvr = wAvg("cvr");

  const fmtRate = (v) => {
    // ShopifyQL may return rates as 0-1 fractions or 0-100 percentages
    const pct = v <= 1 ? v * 100 : v;
    return pct.toFixed(1) + "%";
  };
  const fmtDuration = (s) => {
    if (!s) return "0s";
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  // White → green heat scale (shared so Duration and CVR can be visually correlated).
  // t in [0,1] where 0 = row minimum, 1 = row maximum.
  const heatBg = (t) => {
    if (!isFinite(t)) return "transparent";
    const clamped = Math.max(0, Math.min(1, t));
    // Interpolate alpha on a green fill; background stays "white-ish" at t=0 so low values read white.
    const alpha = (clamped * 0.55).toFixed(3); // 0 → 0, 1 → 0.55
    return `rgba(34, 197, 94, ${alpha})`; // tailwind green-500
  };
  const heatText = (t) => (t > 0.55 ? "#0b3d1f" : "var(--text)");
  const scale = (val, min, max) => (max > min ? (val - min) / (max - min) : 0);

  // Color scale only applies to the top 20 rows (by sessions — rows are already
  // sorted DESC by sessions from the ShopifyQL query). Long-tail pages stay
  // uncolored so the scale stays meaningful for high-traffic comparisons.
  const HEAT_TOP_N = 20;
  const heatRows = rows.slice(0, HEAT_TOP_N);
  const durMin = Math.min(...heatRows.map((r) => r.duration));
  const durMax = Math.max(...heatRows.map((r) => r.duration));
  const cvrMin = Math.min(...heatRows.map((r) => r.cvr));
  const cvrMax = Math.max(...heatRows.map((r) => r.cvr));

  // ── CVR predictor: weighted linear regression CVR = a + b × duration ──
  // Fit uses top-N only (same scope as the heat scale — avoids long-tail noise).
  // Weights = sessions so high-traffic pages dominate the fit.
  // Compute predicted CVR for every row, plus residual (actual − predicted) and
  // a z-score against the top-N residual std-dev, to flag CVR "issues".
  const fit = weightedLinFit(
    heatRows.map((r) => ({ x: r.duration, y: r.cvr, w: Math.max(r.sessions, 1) }))
  );
  // R² across the top-N (weighted)
  let ssRes = 0, ssTot = 0, wSum = 0, wMean = 0;
  heatRows.forEach((r) => { wSum += r.sessions; wMean += r.sessions * r.cvr; });
  wMean = wSum > 0 ? wMean / wSum : 0;
  heatRows.forEach((r) => {
    const pred = fit.a + fit.b * r.duration;
    ssRes += r.sessions * (r.cvr - pred) ** 2;
    ssTot += r.sessions * (r.cvr - wMean) ** 2;
  });
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  // Attach predicted CVR and residual to every row (including long tail, for reference)
  rows.forEach((r) => {
    r.predCvr = fit.a + fit.b * r.duration;
    r.residual = r.cvr - r.predCvr;
  });
  // Residual stdev within the top-N only, for z-score-based flagging
  const topResiduals = heatRows.map((r) => r.residual);
  const meanRes = topResiduals.reduce((a, v) => a + v, 0) / (topResiduals.length || 1);
  const varRes = topResiduals.reduce((a, v) => a + (v - meanRes) ** 2, 0) / (topResiduals.length || 1);
  const sdRes = Math.sqrt(varRes);
  const maxAbsRes = Math.max(...heatRows.map((r) => Math.abs(r.residual)), 1e-9);

  let html = `
    <div class="fb-utm-summary">
      <div class="fb-utm-kpi"><span class="fb-utm-kpi-value">${fmtNum(totalSessions)}</span><span class="fb-utm-kpi-label">Total Sessions</span></div>
      <div class="fb-utm-kpi"><span class="fb-utm-kpi-value">${fmtRate(avgBounce)}</span><span class="fb-utm-kpi-label">Avg Bounce Rate</span></div>
      <div class="fb-utm-kpi"><span class="fb-utm-kpi-value">${fmtDuration(avgDuration)}</span><span class="fb-utm-kpi-label">Avg Session Duration</span></div>
      <div class="fb-utm-kpi"><span class="fb-utm-kpi-value">${fmtRate(avgCart)}</span><span class="fb-utm-kpi-label">Avg Add-to-Cart Rate</span></div>
      <div class="fb-utm-kpi"><span class="fb-utm-kpi-value">${fmtRate(avgCvr)}</span><span class="fb-utm-kpi-label">Avg Conversion Rate</span></div>
    </div>
    <div class="fb-utm-period">
      ${dates.startDate} → ${dates.endDate} · ${rows.length} landing page${rows.length === 1 ? "" : "s"}
      <span class="fb-utm-legend">Duration &amp; CVR scale (top ${Math.min(HEAT_TOP_N, rows.length)} by sessions):
        <span class="fb-utm-legend-bar"><i></i><i></i><i></i><i></i><i></i></span>
        low → high
      </span>
    </div>
    <div class="fb-utm-fit">
      <strong>CVR predictor:</strong>
      <code>CVR ≈ ${(fit.a <= 1 ? fit.a * 100 : fit.a).toFixed(2)}% + ${(fit.b <= 1 ? fit.b * 100 : fit.b).toFixed(4)}%/sec × duration</code>
      · R² = ${r2.toFixed(2)}
      · fit on top ${heatRows.length} by sessions
      <span class="fb-utm-fit-hint">Rows with a red Δ have lower CVR than duration would predict — check these first.</span>
    </div>
    <table class="fb-utm-table">
      <thead>
        <tr>
          <th class="fb-utm-col-path">Landing Page</th>
          <th class="fb-utm-col-num">Sessions</th>
          <th class="fb-utm-col-num">Bounce Rate</th>
          <th class="fb-utm-col-num fb-utm-col-heat">Avg Session Duration</th>
          <th class="fb-utm-col-num">Add-to-Cart Rate</th>
          <th class="fb-utm-col-num fb-utm-col-heat">Conversion Rate</th>
          <th class="fb-utm-col-num">Projected CVR</th>
          <th class="fb-utm-col-num">Δ vs Projected</th>
        </tr>
      </thead>
      <tbody>
  `;

  // Diverging color for residuals: red for below-projection, green for above.
  // Intensity scales to the largest |residual| in the top-N so colors are comparable.
  const residualBg = (res, applyColor) => {
    if (!applyColor || !isFinite(res)) return "";
    const t = Math.max(-1, Math.min(1, res / maxAbsRes));
    const alpha = (Math.abs(t) * 0.55).toFixed(3);
    const rgb = t < 0 ? "239, 68, 68" /* red-500 */ : "34, 197, 94" /* green-500 */;
    return `background:rgba(${rgb}, ${alpha})`;
  };
  // Units: rates may be 0–1 or 0–100. Infer scale from mean absolute CVR.
  const avgAbsCvr = heatRows.reduce((a, r) => a + Math.abs(r.cvr), 0) / (heatRows.length || 1);
  const rateScale = avgAbsCvr <= 1 ? 100 : 1; // multiply to render as percentage points
  const fmtDeltaPct = (res) => {
    const pp = res * rateScale;
    const sign = pp > 0 ? "+" : "";
    return `${sign}${pp.toFixed(2)} pp`;
  };
  const SIG_Z = 1.0; // |residual| > 1σ flagged as "investigate"

  const maxSess = Math.max(...rows.map((r) => r.sessions), 1);
  rows.forEach((r, i) => {
    const barW = (r.sessions / maxSess) * 100;
    const inHeat = i < HEAT_TOP_N;
    const durStyle = inHeat
      ? `background:${heatBg(scale(r.duration, durMin, durMax))};color:${heatText(scale(r.duration, durMin, durMax))}`
      : "";
    const cvrStyle = inHeat
      ? `background:${heatBg(scale(r.cvr, cvrMin, cvrMax))};color:${heatText(scale(r.cvr, cvrMin, cvrMax))}`
      : "";
    const heatCls = inHeat ? " fb-utm-heat" : "";

    // Residual column is colored only for top-N rows (same scope as the fit)
    const z = sdRes > 0 ? r.residual / sdRes : 0;
    const flag = inHeat && z <= -SIG_Z ? '<span class="fb-utm-flag" title="CVR below projection by >1σ — investigate">⚠</span>' : "";

    html += `
      <tr${inHeat ? "" : ' class="fb-utm-row-dim"'}>
        <td class="fb-utm-col-path" title="${esc(r.path)}">${flag}${esc(r.path)}</td>
        <td class="fb-utm-col-num">
          <div class="fb-utm-cell-bar"><span class="fb-utm-bar" style="width:${barW}%"></span><span class="fb-utm-bar-val">${fmtNum(r.sessions)}</span></div>
        </td>
        <td class="fb-utm-col-num">${fmtRate(r.bounce)}</td>
        <td class="fb-utm-col-num${heatCls}" style="${durStyle}">${fmtDuration(r.duration)}</td>
        <td class="fb-utm-col-num">${fmtRate(r.cartRate)}</td>
        <td class="fb-utm-col-num${heatCls}" style="${cvrStyle}">${fmtRate(r.cvr)}</td>
        <td class="fb-utm-col-num">${fmtRate(r.predCvr)}</td>
        <td class="fb-utm-col-num fb-utm-delta" style="${residualBg(r.residual, inHeat)}">${fmtDeltaPct(r.residual)}</td>
      </tr>
    `;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}

function weightedLinFit(points) {
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  for (const p of points) {
    const w = p.w || 1;
    sw += w; swx += w * p.x; swy += w * p.y;
    swxx += w * p.x * p.x; swxy += w * p.x * p.y;
  }
  if (!sw) return { a: 0, b: 0 };
  const denom = sw * swxx - swx * swx;
  if (Math.abs(denom) < 1e-12) return { a: swy / sw, b: 0 };
  const b = (sw * swxy - swx * swy) / denom;
  const a = (swy - b * swx) / sw;
  return { a, b };
}

function coerceNum(v) {
  if (typeof v === "number") return v;
  if (!v) return 0;
  return parseFloat(String(v).replace(/[,$]/g, "")) || 0;
}

function buildUtmAnalysis(sessionsResult, totalsResult) {
  const rows = sessionsResult.rows.map((r) => ({
    source: r.utm_source || "(direct)",
    medium: r.utm_medium || "(none)",
    sessions: coerceNum(r.sessions),
    orders: coerceNum(r.sessions_that_completed_checkout),
    cvr: coerceNum(r.conversion_rate),
  }));

  // Build a lookup map keyed by "source / medium"
  const byKey = {};
  for (const row of rows) byKey[`${row.source} / ${row.medium}`] = row;

  const totRow = totalsResult.rows[0] || {};
  const totalSessions = coerceNum(totRow.sessions);
  const totalOrders = coerceNum(totRow.sessions_that_completed_checkout);

  return { rows, byKey, totalSessions, totalOrders };
}

function fmtDelta(current, previous) {
  if (!previous) return `<span class="utm-delta utm-delta-new">NEW</span>`;
  const diff = current - previous;
  if (diff === 0) return `<span class="utm-delta utm-delta-flat">—</span>`;
  const pct = previous !== 0 ? ((diff / previous) * 100).toFixed(0) : (diff > 0 ? "∞" : "-∞");
  const sign = diff > 0 ? "+" : "";
  const cls = diff > 0 ? "utm-delta-up" : "utm-delta-down";
  return `<span class="utm-delta ${cls}">${sign}${pct}%</span>`;
}

function fmtDeltaPts(current, previous) {
  if (previous == null) return `<span class="utm-delta utm-delta-new">NEW</span>`;
  const diff = current - previous;
  if (Math.abs(diff) < 0.005) return `<span class="utm-delta utm-delta-flat">—</span>`;
  const sign = diff > 0 ? "+" : "";
  const cls = diff > 0 ? "utm-delta-up" : "utm-delta-down";
  return `<span class="utm-delta ${cls}">${sign}${diff.toFixed(2)}pp</span>`;
}

function renderUtmAnalysis(container, analysis, prevAnalysis, dates) {
  if (!analysis.rows.length) {
    container.innerHTML = `<div class="utm-empty">
      <p>No session data found for this landing page in the selected date range.</p>
      <p style="font-size:12px;color:var(--text2);margin-top:6px">Data is queried via ShopifyQL on the <code>sessions</code> table, filtered by <code>landing_page_path</code>.</p>
    </div>`;
    return;
  }

  const overallCvr = analysis.totalSessions > 0
    ? ((analysis.totalOrders / analysis.totalSessions) * 100).toFixed(2)
    : "0.00";
  const prevCvr = prevAnalysis.totalSessions > 0
    ? ((prevAnalysis.totalOrders / prevAnalysis.totalSessions) * 100).toFixed(2)
    : "0.00";

  let html = `<div class="utm-period-label" style="font-size:11px;color:var(--text2);margin-bottom:8px">
    Current: ${dates.startDate} → ${dates.endDate} &nbsp;|&nbsp; Previous: ${dates.prevStartDate} → ${dates.prevEndDate}
  </div>`;

  html += `<div class="utm-summary">
    <div class="utm-stat">
      <span class="utm-stat-value">${fmtNum(analysis.totalSessions)}</span>
      ${fmtDelta(analysis.totalSessions, prevAnalysis.totalSessions)}
      <span class="utm-stat-label">Sessions</span>
    </div>
    <div class="utm-stat">
      <span class="utm-stat-value">${fmtNum(analysis.totalOrders)}</span>
      ${fmtDelta(analysis.totalOrders, prevAnalysis.totalOrders)}
      <span class="utm-stat-label">Checkouts</span>
    </div>
    <div class="utm-stat">
      <span class="utm-stat-value">${overallCvr}%</span>
      ${fmtDeltaPts(parseFloat(overallCvr), parseFloat(prevCvr))}
      <span class="utm-stat-label">CVR</span>
    </div>
  </div>`;

  // Find max sessions for relative bars
  const maxSess = Math.max(...analysis.rows.map((r) => r.sessions), 1);

  html += `<div class="utm-table-wrap"><table class="utm-table">
    <thead><tr>
      <th>Source / Medium</th>
      <th>Sessions</th>
      <th>Checkouts</th>
      <th>CVR</th>
      <th>% of Traffic</th>
    </tr></thead><tbody>`;

  for (const row of analysis.rows) {
    const key = `${row.source} / ${row.medium}`;
    const prev = prevAnalysis.byKey[key];

    const cvr = row.sessions > 0 ? ((row.orders / row.sessions) * 100).toFixed(2) : "0.00";
    const prevRowCvr = prev && prev.sessions > 0 ? ((prev.orders / prev.sessions) * 100) : null;
    const trafficPct = analysis.totalSessions > 0
      ? ((row.sessions / analysis.totalSessions) * 100).toFixed(1)
      : "0.0";
    const barWidth = (row.sessions / maxSess) * 100;

    // Color CVR: green if above overall, red if below
    const cvrNum = parseFloat(cvr);
    const overallNum = parseFloat(overallCvr);
    const cvrClass = cvrNum >= overallNum ? "utm-cvr-good" : "utm-cvr-bad";

    html += `<tr>
      <td>
        <div class="utm-source-cell">
          <span class="utm-source-name">${esc(row.source)} / ${esc(row.medium)}</span>
          <div class="utm-source-bar"><div class="utm-source-bar-fill" style="width:${barWidth}%"></div></div>
        </div>
      </td>
      <td class="utm-num">${fmtNum(row.sessions)} ${fmtDelta(row.sessions, prev ? prev.sessions : null)}</td>
      <td class="utm-num">${fmtNum(row.orders)} ${fmtDelta(row.orders, prev ? prev.orders : null)}</td>
      <td class="utm-num ${cvrClass}">${cvr}% ${fmtDeltaPts(parseFloat(cvr), prevRowCvr)}</td>
      <td class="utm-num">${trafficPct}%</td>
    </tr>`;
  }

  html += `</tbody></table></div>`;
  container.innerHTML = html;
}
