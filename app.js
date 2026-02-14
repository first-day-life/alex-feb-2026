/* ═══════════════════════════════════════════════════
   LP Explorer – app.js
   Reads a Google Sheet (published as CSV) and renders
   an interactive dashboard with iframe page preview.
   ═══════════════════════════════════════════════════ */

// ── Demo data (used when no sheet URL is configured) ──
const DEFAULT_SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRCpN6f4J91aFKu9PFdPyqkWxc_q96mYif3JyCY9zI2C4VmoNHULLTvpa-XDOS_fkV9cIn2_0RfYZ_E/pub?gid=1538474996&single=true&output=csv";
const DEMO_DATA = [
  { url: "https://example.com", name: "Homepage", cvr: 4.2, bounce: 32, sessions: 12840 },
  { url: "https://example.com/pricing", name: "Pricing Page", cvr: 6.8, bounce: 24, sessions: 8920 },
  { url: "https://example.com/features", name: "Features Overview", cvr: 3.1, bounce: 41, sessions: 7540 },
  { url: "https://example.com/blog/seo-guide", name: "SEO Ultimate Guide", cvr: 1.9, bounce: 58, sessions: 15200 },
  { url: "https://example.com/signup", name: "Sign Up", cvr: 12.4, bounce: 18, sessions: 6100 },
  { url: "https://example.com/demo", name: "Book a Demo", cvr: 8.7, bounce: 22, sessions: 4300 },
  { url: "https://example.com/case-studies", name: "Case Studies", cvr: 5.3, bounce: 35, sessions: 3800 },
  { url: "https://example.com/blog/growth-tips", name: "10 Growth Tips", cvr: 2.1, bounce: 52, sessions: 11400 },
  { url: "https://example.com/integrations", name: "Integrations", cvr: 3.8, bounce: 39, sessions: 5600 },
  { url: "https://example.com/about", name: "About Us", cvr: 1.2, bounce: 61, sessions: 4100 },
  { url: "https://example.com/contact", name: "Contact", cvr: 7.1, bounce: 28, sessions: 2900 },
  { url: "https://example.com/blog/product-update", name: "Product Update Q4", cvr: 2.8, bounce: 45, sessions: 9700 },
  { url: "https://example.com/enterprise", name: "Enterprise Plan", cvr: 9.2, bounce: 20, sessions: 3200 },
  { url: "https://example.com/docs", name: "Documentation", cvr: 0.8, bounce: 67, sessions: 18500 },
  { url: "https://example.com/webinar", name: "Free Webinar", cvr: 11.5, bounce: 15, sessions: 2400 },
];

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
let lastFiltered = [];

// ── DOM refs ────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const sidebarEl = $("#sidebar");
const listEl = $("#page-list");
const searchEl = $("#search");
const sortEl = $("#sort-select");
const previewEmpty = $("#preview-empty");
const previewWrap = $("#preview-frame-wrap");
const frameUrl = $("#frame-url");
const frameExternal = $("#frame-external");
const settingsModal = $("#settings-modal");

// ── Init ────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  loadSavedSettings();
  bindEvents();
  loadData();
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

  // Settings
  $("#settings-btn").addEventListener("click", () => settingsModal.classList.remove("hidden"));
  $("#settings-cancel").addEventListener("click", () => settingsModal.classList.add("hidden"));
  $(".modal-backdrop").addEventListener("click", () => settingsModal.classList.add("hidden"));
  $("#settings-save").addEventListener("click", saveSettings);

  // Keyboard nav
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") settingsModal.classList.add("hidden");
    if (e.key === "/" && document.activeElement !== searchEl) {
      e.preventDefault();
      searchEl.focus();
    }
  });
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
  const saved = localStorage.getItem("lp-explorer-settings");
  let sheetUrl = "";
  let colMap = {
    day: "day",
    url: "landing_page_path",
    name: "landing_page_path",
    cvr: "conversion_rate",
    bounce: "bounce_rate",
    sessions: "sessions",
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

  if (!sheetUrl) {
    pages = [...DEMO_DATA];
    toast("Using demo data — click ⚙ to connect your Google Sheet");
    renderList();
    return;
  }

  try {
    toast("Loading sheet data...");
    const resp = await fetch(sheetUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const csv = await resp.text();
    pages = parseCSV(csv, colMap);
    toast(`Loaded ${pages.length} pages from your sheet`);
  } catch (err) {
    toast(`Error loading sheet: ${err.message}`);
    pages = [...DEMO_DATA];
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
    const li = document.createElement("li");
    li.className = `page-card${activePage && activePage.url === page.url ? " active" : ""}`;
    li.style.animationDelay = `${i * 40}ms`;
    li.innerHTML = `
      <div class="page-card-title">${esc(page.name)}</div>
      <div class="page-card-url">${esc(page.url)}</div>
      <div class="page-card-metrics">
        <div class="metric">
          <span class="metric-value ${cvrClass(page.cvr)}">${page.cvr.toFixed(1)}%</span>
          <span class="metric-label">CVR</span>
        </div>
        <div class="metric">
          <span class="metric-value ${bounceClass(page.bounce)}">${page.bounce.toFixed(0)}%</span>
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
    li.addEventListener("click", () => selectPage(page, li));
    listEl.appendChild(li);
  });

  updateSummary(filtered);
}

function selectPage(page, cardEl) {
  activePage = page;

  // Update active card
  document.querySelectorAll(".page-card").forEach((c) => c.classList.remove("active"));
  cardEl.classList.add("active");

  // Show preview
  previewEmpty.classList.add("hidden");
  previewWrap.classList.remove("hidden");

  frameUrl.textContent = page.url;
  frameExternal.href = page.url;
  window.open(page.url, "_blank", "noopener");

  updateComparison(page, lastFiltered);

  // On mobile, close sidebar after selection
  if (window.innerWidth <= 768) {
    sidebarEl.classList.remove("open");
    sidebarEl.classList.add("closed");
  }
}

// ── Summary ─────────────────────────────────────────
function updateSummary(filtered) {
  $("#total-pages").textContent = filtered.length;
  const avgCvr = filtered.length ? filtered.reduce((s, p) => s + p.cvr, 0) / filtered.length : 0;
  $("#avg-cvr").textContent = avgCvr.toFixed(1) + "%";
  const totalSess = filtered.reduce((s, p) => s + p.sessions, 0);
  $("#total-sessions").textContent = fmtNum(totalSess);
}

function updateComparison(selected, filtered) {
  const others = filtered.filter((p) => p.url !== selected.url);
  const agg = aggregatePages(others);

  $("#compare-selected-name").textContent = selected.name;
  $("#compare-selected-url").textContent = selected.url;
  $("#compare-selected-cvr").textContent = selected.cvr.toFixed(1) + "%";
  $("#compare-selected-bounce").textContent = selected.bounce.toFixed(0) + "%";
  $("#compare-selected-sessions").textContent = fmtNum(selected.sessions);

  $("#compare-other-count").textContent = `${agg.count} ${agg.count === 1 ? "page" : "pages"}`;
  $("#compare-other-cvr").textContent = agg.weightedCvr.toFixed(1) + "%";
  $("#compare-other-bounce").textContent = agg.weightedBounce.toFixed(0) + "%";
  $("#compare-other-sessions").textContent = fmtNum(agg.sessions);
}

// ── Helpers ─────────────────────────────────────────
function cvrClass(v) {
  if (v >= 5) return "good";
  if (v >= 2) return "ok";
  return "bad";
}
function bounceClass(v) {
  if (v <= 30) return "good";
  if (v <= 50) return "ok";
  return "bad";
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

function aggregatePages(items) {
  if (!items.length) {
    return { count: 0, sessions: 0, weightedCvr: 0, weightedBounce: 0 };
  }
  const sessions = items.reduce((s, p) => s + p.sessions, 0);
  const weightedCvr = sessions
    ? items.reduce((s, p) => s + p.cvr * p.sessions, 0) / sessions
    : 0;
  const weightedBounce = sessions
    ? items.reduce((s, p) => s + p.bounce * p.sessions, 0) / sessions
    : 0;
  return { count: items.length, sessions, weightedCvr, weightedBounce };
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
