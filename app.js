/* ═══════════════════════════════════════════════════
   LP Explorer – app.js
   Reads a Google Sheet (published as CSV) and renders
   an interactive dashboard with iframe page preview.
   ═══════════════════════════════════════════════════ */

// ── Default sheet URL ───────────────────────────────
const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRCpN6f4J91aFKu9PFdPyqkWxc_q96mYif3JyCY9zI2C4VmoNHULLTvpa-XDOS_fkV9cIn2_0RfYZ_E/pub?gid=592398799&single=true&output=csv";

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
let pages = [];
let activePage = null;
let selectedPages = []; // compare mode selections
let compareMode = false;
let lastFiltered = [];

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
      sheetUrl = s.sheetUrl || DEFAULT_SHEET_URL;
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
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const csv = await resp.text();
    pages = parseCSV(csv, colMap);
    toast(`Loaded ${pages.length} pages from your sheet URL`);
  } catch (err) {
    toast(`Error loading sheet: ${err.message}`);
    pages = [];
  } finally {
    setLoading(false);
  }

  renderList();
}

// ── CSV parser ──────────────────────────────────────
function parseCSV(text, colMap) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const idxDay = headers.findIndex((h) => h.toLowerCase() === colMap.day.toLowerCase());
  const idxUrl = headers.findIndex((h) => h.toLowerCase() === colMap.url.toLowerCase());
  const idxName = headers.findIndex((h) => h.toLowerCase() === colMap.name.toLowerCase());
  const idxCvr = headers.findIndex((h) => h.toLowerCase() === colMap.cvr.toLowerCase());
  const idxBounce = headers.findIndex((h) => h.toLowerCase() === colMap.bounce.toLowerCase());
  const idxSessions = headers.findIndex((h) => h.toLowerCase() === colMap.sessions.toLowerCase());
  const idxAddedToCart = headers.findIndex((h) => h.toLowerCase() === colMap.addedToCart.toLowerCase());
  const idxReachedCheckout = headers.findIndex((h) => h.toLowerCase() === colMap.reachedCheckout.toLowerCase());
  const idxCompletedCheckout = headers.findIndex((h) => h.toLowerCase() === colMap.completedCheckout.toLowerCase());
  const idxSessionsCompleted = headers.findIndex((h) => h.toLowerCase() === colMap.sessionsCompleted.toLowerCase());

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    const day = idxDay >= 0 ? (cols[idxDay] || "").trim() : "";
    const path = idxUrl >= 0 ? (cols[idxUrl] || "").trim() : "";
    if (!path) continue;
    if (day && day.toLowerCase() === "day") continue; // skip duplicate header rows

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

  if (!rows.length) return [];

  // If a day column exists, only keep the latest day
  let latestRows = rows;
  if (idxDay >= 0) {
    const latestDay = rows
      .map((r) => r.day)
      .filter(Boolean)
      .sort()
      .slice(-1)[0];
    if (latestDay) latestRows = rows.filter((r) => r.day === latestDay);
  }

  const baseUrl = "https://firstday.com";
  return latestRows.map((r) => ({
    url: baseUrl + normalizePath(r.path),
    name: r.name,
    cvr: r.cvr,
    bounce: r.bounce,
    sessions: r.sessions,
    addedToCartRate: r.addedToCartRate,
    reachedCheckoutRate: r.reachedCheckoutRate,
    completedCheckoutRate: r.completedCheckoutRate,
    sessionsCompleted: r.sessionsCompleted,
  }));
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
function renderCompareGrid() {
  const pagesToRender = compareMode ? selectedPages : (activePage ? [activePage] : []);

  if (!pagesToRender.length) {
    compareGrid.innerHTML = "";
    return;
  }

  const avg = computeFunnelAverages(lastFiltered);
  const colCount = pagesToRender.length;

  // Color palette for compare mode columns
  const colors = [
    { accent: "#6c5ce7", accent2: "#a78bfa" },
    { accent: "#f59e0b", accent2: "#fbbf24" },
    { accent: "#10b981", accent2: "#34d399" },
    { accent: "#ef4444", accent2: "#f87171" },
    { accent: "#3b82f6", accent2: "#60a5fa" },
    { accent: "#ec4899", accent2: "#f472b6" },
  ];

  compareGrid.className = colCount > 1 ? "compare-grid-multi" : "";
  compareGrid.style.setProperty("--col-count", colCount);

  // Extract step data for each page
  function getStepData(page) {
    const sessions = page.sessions || 0;
    const nonBouncePct = clampRate(100 - (page.bounce || 0));
    const atcPct = clampRate(page.addedToCartRate || 0);
    const reachPct = clampRate(page.reachedCheckoutRate || 0);
    const completedPct = clampRate(page.completedCheckoutRate || 0);
    const completedSessions = page.sessionsCompleted > 0
      ? page.sessionsCompleted
      : Math.round(sessions * (completedPct / 100));
    return {
      sessions,
      nonBouncePct,
      atcPct,
      reachPct,
      completedPct,
      completedSessions,
      nonBounceSessions: Math.round(sessions * (nonBouncePct / 100)),
      addedSessions: Math.round(sessions * (atcPct / 100)),
      reachedSessions: Math.round(sessions * (reachPct / 100)),
    };
  }

  const allStepData = pagesToRender.map(getStepData);
  const baseline = colCount > 1 ? allStepData[0] : null;

  let html = "";
  pagesToRender.forEach((page, idx) => {
    const color = colors[idx % colors.length];
    const sd = allStepData[idx];
    const diff = (baseline && idx > 0) ? baseline : null;

    const borderStyle = colCount > 1 ? `border-top: 3px solid ${color.accent}` : "";
    const removeBtn = compareMode ? `<button class="funnel-remove-btn" data-idx="${idx}" aria-label="Remove from comparison">&times;</button>` : "";
    const baselineLabel = (colCount > 1 && idx === 0) ? `<span class="funnel-baseline-badge">Baseline</span>` : "";

    // KPI diffs vs baseline
    let cvrDiffHtml = "";
    let sessionsDiffHtml = "";
    let completedDiffHtml = "";
    if (diff) {
      cvrDiffHtml = renderDiffBadge(page.cvr, pagesToRender[0].cvr, true);
      sessionsDiffHtml = renderDiffBadge(sd.sessions, diff.sessions, true, true);
      completedDiffHtml = renderDiffBadge(sd.completedSessions, diff.completedSessions, true, true);
    }

    html += `
      <div class="funnel-column" style="${borderStyle}">
        <div class="funnel-header">
          <div class="funnel-title">Purchase Funnel ${baselineLabel}${removeBtn}</div>
          <div class="funnel-page">
            <div class="funnel-page-name">${esc(page.name)}</div>
            <div class="funnel-page-url">${esc(page.url)}</div>
          </div>
          <div class="funnel-kpis">
            <div class="funnel-kpi">
              <span class="funnel-kpi-value">${page.cvr.toFixed(1)}%</span>
              ${cvrDiffHtml}
              <span class="funnel-kpi-label">Conversion Rate</span>
            </div>
            <div class="funnel-kpi">
              <span class="funnel-kpi-value">${fmtNum(sd.sessions)}</span>
              ${sessionsDiffHtml}
              <span class="funnel-kpi-label">Sessions</span>
            </div>
            <div class="funnel-kpi">
              <span class="funnel-kpi-value">${fmtNum(sd.completedSessions)}</span>
              ${completedDiffHtml}
              <span class="funnel-kpi-label">Completed</span>
            </div>
          </div>
        </div>
        <div class="funnel-steps">
          ${renderFunnelStep("Sessions", 100, sd.sessions, null, 100, color, diff ? { pct: 100, count: diff.sessions } : null)}
          ${renderFunnelStep("Did Not Bounce", sd.nonBouncePct, sd.nonBounceSessions, sd.sessions, avg.nonBouncePct, color, diff ? { pct: baseline.nonBouncePct, count: baseline.nonBounceSessions } : null)}
          ${renderFunnelStep("Added to Cart", sd.atcPct, sd.addedSessions, sd.nonBounceSessions, avg.addedPct, color, diff ? { pct: baseline.atcPct, count: baseline.addedSessions } : null)}
          ${renderFunnelStep("Reached Checkout", sd.reachPct, sd.reachedSessions, sd.addedSessions, avg.reachedPct, color, diff ? { pct: baseline.reachPct, count: baseline.reachedSessions } : null)}
          ${renderFunnelStep("Completed Checkout", sd.completedPct, sd.completedSessions, sd.reachedSessions, avg.completedPct, color, diff ? { pct: baseline.completedPct, count: baseline.completedSessions } : null)}
        </div>
      </div>
    `;
  });

  compareGrid.innerHTML = html;

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

  // Equalize row heights across columns so steps line up
  if (colCount > 1) {
    requestAnimationFrame(() => alignCompareRows());
  }
}

function alignCompareRows() {
  const columns = compareGrid.querySelectorAll(".funnel-column");
  if (columns.length < 2) return;

  // Collect matching elements per row: header, then each step
  const selectors = [".funnel-header"];
  const stepCount = columns[0].querySelectorAll(".funnel-step").length;
  for (let i = 0; i < stepCount; i++) {
    selectors.push(`.funnel-step:nth-child(${i + 1})`);
  }

  selectors.forEach((sel) => {
    const els = Array.from(columns).map((col) => {
      if (sel === ".funnel-header") return col.querySelector(sel);
      return col.querySelector(`.funnel-steps`).querySelector(sel);
    }).filter(Boolean);

    // Reset heights first
    els.forEach((el) => el.style.minHeight = "");

    // Find max natural height
    const maxH = Math.max(...els.map((el) => el.offsetHeight));

    // Apply to all
    els.forEach((el) => el.style.minHeight = maxH + "px");
  });
}

function renderFunnelStep(label, pct, count, prevCount, avgPct, color, baselineStep) {
  let dropoffHtml = "";
  if (prevCount !== null) {
    const drop = Math.max(0, prevCount - count);
    const dropPct = prevCount > 0 ? (drop / prevCount) * 100 : 0;
    dropoffHtml = `
      <div class="funnel-step-dropoff">
        <span class="funnel-step-dropoff-label">Drop-off</span>
        <span class="funnel-step-dropoff-value">${fmtNum(drop)} (${dropPct.toFixed(1)}%)</span>
      </div>`;
  }

  // Diff vs baseline
  let diffHtml = "";
  if (baselineStep) {
    diffHtml = `<div class="funnel-step-diff">${renderDiffBadge(pct, baselineStep.pct, true)}</div>`;
  }

  const barGradient = color
    ? `background: linear-gradient(90deg, ${color.accent}, ${color.accent2})`
    : `background: linear-gradient(90deg, var(--accent), var(--accent2))`;

  return `
    <div class="funnel-step">
      <div class="funnel-step-label">${label}</div>
      <div class="funnel-step-metrics">
        <span class="funnel-step-pct">${pct.toFixed(1)}%</span>
        ${avgPct !== null ? `<span class="funnel-step-avg">(vs avg ${avgPct.toFixed(1)}%)</span>` : ""}
        <span class="funnel-step-count">${fmtNum(count)}</span>
      </div>
      ${diffHtml}
      ${dropoffHtml}
      <div class="funnel-step-bar">
        <div class="funnel-step-bar-fill" style="width: ${Math.max(2, Math.min(100, pct))}%; ${barGradient}"></div>
      </div>
    </div>`;
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
