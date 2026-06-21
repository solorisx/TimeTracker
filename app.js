/* ===========================================================================
 * Time Tracker — vanilla JS, no dependencies.
 * Sections: Storage · State · Helpers · Timer · Render · Events · Init
 * ======================================================================== */

"use strict";

/* ---------------------------------------------------------------------------
 * 0. Constants & globals
 * ------------------------------------------------------------------------ */
const HAS_FS_ACCESS = typeof window.showSaveFilePicker === "function";
const LS_KEY = "timetracker.data";
const IDB_NAME = "timetracker";
const IDB_STORE = "handles";
const IDB_HANDLE_KEY = "dataFile";

let state = emptyState();
let fileHandle = null;     // FileSystemFileHandle when connected (FS Access mode)
let saveTimer = null;      // debounce handle for saving
let tickTimer = null;      // setInterval for the live timer display

function emptyState() {
  return { version: 2, projects: [], entries: [], running: null };
}

/* ---------------------------------------------------------------------------
 * 1. Storage layer
 * ------------------------------------------------------------------------ */

// --- IndexedDB helpers (persist the FileSystemFileHandle across reloads) ---
function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Permission helper for a stored handle ---
async function ensurePermission(handle, mode = "readwrite") {
  const opts = { mode };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  if ((await handle.requestPermission(opts)) === "granted") return true;
  return false;
}

// --- Connect (create or open) a data file ---
async function connectFile() {
  try {
    const handle = await window.showSaveFilePicker({
      suggestedName: "timetracker.json",
      types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
    });
    fileHandle = handle;
    await idbSet(IDB_HANDLE_KEY, handle);
    const file = await handle.getFile();
    const text = (await file.text()).trim();
    if (text) {
      state = normalize(JSON.parse(text));
    } else {
      await writeFile();
    }
    renderAll();
  } catch (err) {
    if (err && err.name === "AbortError") return;
    console.error(err);
    alert("Could not connect the data file: " + err.message);
  }
}

// --- Open an existing data file ---
async function openFile() {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      multiple: false,
    });
    fileHandle = handle;
    await idbSet(IDB_HANDLE_KEY, handle);
    await readFile();
    renderAll();
  } catch (err) {
    if (err && err.name === "AbortError") return;
    console.error(err);
    alert("Could not open the data file: " + err.message);
  }
}

// --- Reconnect to a previously stored handle on startup ---
async function tryRestoreHandle() {
  if (!HAS_FS_ACCESS) return false;
  try {
    const handle = await idbGet(IDB_HANDLE_KEY);
    if (!handle) return false;
    if (!(await ensurePermission(handle))) return false;
    fileHandle = handle;
    await readFile();
    return true;
  } catch (err) {
    console.warn("Could not restore previous file:", err);
    return false;
  }
}

// --- Read current state from the connected file ---
async function readFile() {
  if (!fileHandle) return;
  const file = await fileHandle.getFile();
  const text = (await file.text()).trim();
  state = text ? normalize(JSON.parse(text)) : emptyState();
}

// --- Write current state to the connected file (FS Access mode) ---
async function writeFile() {
  if (!fileHandle) return;
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(state, null, 2));
  await writable.close();
}

// --- Persist: debounced; routes to file or localStorage ---
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 300);
}

async function persist() {
  try {
    if (fileHandle) {
      await writeFile();
    } else {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    }
  } catch (err) {
    console.error("Save failed:", err);
  }
}

// --- Normalize loaded data so missing fields don't break the app ---
function normalize(data) {
  const s = emptyState();
  if (data && typeof data === "object") {
    if (Array.isArray(data.projects)) {
      s.projects = data.projects.map((p) => ({
        ...p,
        categories: Array.isArray(p.categories) ? p.categories : [],
      }));
    }
    if (Array.isArray(data.entries)) s.entries = data.entries;
    if (data.running && data.running.projectId) s.running = data.running;
  }
  return s;
}

// --- Fallback export / import (non FS-Access browsers) ---
function exportJSON() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "timetracker.json";
  a.click();
  URL.revokeObjectURL(url);
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      state = normalize(JSON.parse(reader.result));
      persist();
      renderAll();
    } catch (err) {
      alert("Invalid JSON file: " + err.message);
    }
  };
  reader.readAsText(file);
}

/* ---------------------------------------------------------------------------
 * 2. State mutation helpers
 * ------------------------------------------------------------------------ */
function commit() {
  scheduleSave();
  renderAll();
}

function addProject(name, color) {
  state.projects.push({
    id: crypto.randomUUID(),
    name: name.trim(),
    color,
    createdAt: new Date().toISOString(),
    archived: false,
    categories: [],
  });
  commit();
}

function setProjectArchived(id, archived) {
  const p = state.projects.find((p) => p.id === id);
  if (p) { p.archived = archived; commit(); }
}

function deleteProject(id) {
  const count = state.entries.filter((e) => e.projectId === id).length;
  const msg = count
    ? `Delete this project and its ${count} time entr${count === 1 ? "y" : "ies"}?`
    : "Delete this project?";
  if (!confirm(msg)) return;
  state.projects = state.projects.filter((p) => p.id !== id);
  state.entries = state.entries.filter((e) => e.projectId !== id);
  if (state.running && state.running.projectId === id) state.running = null;
  commit();
}

function addCategory(projectId, name) {
  const p = projectById(projectId);
  if (!p) return;
  if (!Array.isArray(p.categories)) p.categories = [];
  p.categories.push({ id: crypto.randomUUID(), name: name.trim() });
  commit();
}

function deleteCategory(projectId, catId) {
  const p = projectById(projectId);
  if (!p || !Array.isArray(p.categories)) return;
  // Entries that had this category automatically fall into "Other" (categoryId no longer matches)
  p.categories = p.categories.filter((c) => c.id !== catId);
  commit();
}

function addEntry({ projectId, start, end, durationSec, note, categoryId }) {
  state.entries.push({
    id: crypto.randomUUID(),
    projectId,
    start: start || null,
    end: end || null,
    durationSec,
    note: (note || "").trim(),
    categoryId: categoryId || null,
  });
  commit();
}

function updateEntry(id, fields) {
  const e = state.entries.find((e) => e.id === id);
  if (e) { Object.assign(e, fields); commit(); }
}

function deleteEntry(id) {
  if (!confirm("Delete this entry?")) return;
  state.entries = state.entries.filter((e) => e.id !== id);
  commit();
}

/* ---------------------------------------------------------------------------
 * 3. Formatting helpers
 * ------------------------------------------------------------------------ */
function secToHMS(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h, m, s].map((n) => String(n).padStart(2, "0")).join(":");
}

function secToHM(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

// Parse "hh:mm" or "h:mm" -> seconds (null if invalid)
function parseHM(str) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(str.trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}

function secToHMInput(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}`;
}

function projectById(id) {
  return state.projects.find((p) => p.id === id);
}

// The reference date for an entry (its day): start if present, else end, else null
function entryDate(e) {
  return e.start || e.end || null;
}

function todayISODate() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

// Build <option> tags for a category select for the given project.
// selectedCatId=null/"" → "Other" option is selected.
function categoryOptionsHTML(projectId, selectedCatId) {
  const p = projectById(projectId);
  const cats = (p && p.categories) || [];
  const noneSelected = !selectedCatId || !cats.find((c) => c.id === selectedCatId);
  return (
    `<option value=""${noneSelected ? " selected" : ""}>Other</option>` +
    cats
      .map(
        (c) =>
          `<option value="${c.id}"${c.id === selectedCatId ? " selected" : ""}>${escapeHTML(c.name)}</option>`
      )
      .join("")
  );
}

// Refresh a category <select> for the given project.
// Hides the element when the project has no custom categories.
// If selectedCatId is omitted the current element value is preserved (falls back to "Other" if no longer valid).
function refreshCategorySelect(selectId, projectId, selectedCatId) {
  const sel = $(selectId);
  if (!sel) return;
  const p = projectById(projectId);
  const cats = (p && p.categories) || [];
  if (cats.length === 0) {
    sel.hidden = true;
    sel.innerHTML = `<option value="">Other</option>`;
    return;
  }
  sel.hidden = false;
  const prev = selectedCatId !== undefined ? selectedCatId : sel.value;
  sel.innerHTML = categoryOptionsHTML(projectId, prev);
}

// Same as refreshCategorySelect but for a plain <label> wrapper — also hides the label.
function refreshCategoryField(labelId, selectId, projectId, selectedCatId) {
  const lbl = $(labelId);
  const p = projectById(projectId);
  const cats = (p && p.categories) || [];
  if (lbl) lbl.hidden = cats.length === 0;
  refreshCategorySelect(selectId, projectId, selectedCatId);
}

/* ---------------------------------------------------------------------------
 * 4. Timer
 * ------------------------------------------------------------------------ */
function startTimer(projectId, note, categoryId) {
  if (!projectId) { alert("Create and select a project first."); return; }
  state.running = {
    projectId,
    start: new Date().toISOString(),
    note: (note || "").trim(),
    categoryId: categoryId || null,
  };
  commit();
  startTick();
}

function stopTimer() {
  if (!state.running) return;
  const start = new Date(state.running.start);
  const end = new Date();
  const durationSec = Math.max(1, Math.round((end - start) / 1000));
  const { projectId, note, categoryId } = state.running;
  state.running = null;
  addEntry({ projectId, start: start.toISOString(), end: end.toISOString(), durationSec, note, categoryId });
  stopTick();
  renderTimer();
}

function startTick() {
  stopTick();
  tickTimer = setInterval(renderTimerDisplay, 1000);
  renderTimerDisplay();
}

function stopTick() {
  clearInterval(tickTimer);
  tickTimer = null;
}

/* ---------------------------------------------------------------------------
 * 5. Rendering
 * ------------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);

function renderAll() {
  renderFileStatus();
  renderProjectSelects();
  renderProjects();
  renderTimer();
  renderSummary();
  renderCategoryStats();
  renderEntries();
}

function renderFileStatus() {
  const status = $("fileStatus");
  if (fileHandle) {
    status.textContent = "Connected: " + fileHandle.name;
    status.classList.add("connected");
    $("reloadBtn").hidden = false;
  } else if (HAS_FS_ACCESS) {
    status.textContent = "Not connected — using temporary storage";
    status.classList.remove("connected");
    $("reloadBtn").hidden = true;
  } else {
    status.textContent = "Browser storage (use Export to back up)";
    status.classList.remove("connected");
  }
}

function projectOptionsHTML(selectedId) {
  return state.projects
    .filter((p) => !p.archived)
    .map(
      (p) =>
        `<option value="${p.id}"${p.id === selectedId ? " selected" : ""}>${escapeHTML(p.name)}</option>`
    )
    .join("");
}

function renderProjectSelects() {
  const active = state.projects.filter((p) => !p.archived);

  for (const id of ["timerProject", "manualProject"]) {
    const sel = $(id);
    const prev = sel.value;
    sel.innerHTML = active.length
      ? projectOptionsHTML(prev)
      : `<option value="">No projects yet</option>`;
    if (active.some((p) => p.id === prev)) sel.value = prev;
  }

  // Category selects follow the selected project (preserve selection if still valid)
  refreshCategorySelect("timerCategory", $("timerProject").value);
  refreshCategoryField("manualCategoryLabel", "manualCategory", $("manualProject").value);

  // Category stats project dropdown
  const catSel = $("catStatsProject");
  if (catSel) {
    const prev = catSel.value;
    catSel.innerHTML =
      `<option value="">Select a project…</option>` +
      active
        .map(
          (p) =>
            `<option value="${p.id}"${p.id === prev ? " selected" : ""}>${escapeHTML(p.name)}</option>`
        )
        .join("");
    if (active.some((p) => p.id === prev)) catSel.value = prev;
  }
}

function renderProjects() {
  const ul = $("projectList");
  if (!state.projects.length) {
    ul.innerHTML = `<li class="empty">No projects yet. Add one above.</li>`;
    return;
  }
  const totals = totalsByProject();
  ul.innerHTML = state.projects
    .map((p) => {
      const total = secToHM(totals[p.id] || 0);
      const catCount = (p.categories || []).length;
      return `<li class="${p.archived ? "archived" : ""}">
        <span class="color-dot" style="background:${escapeAttr(p.color)}"></span>
        <span class="project-name">${escapeHTML(p.name)}</span>
        <span class="project-total">${total}</span>
        <button type="button" class="secondary" data-cats="${p.id}">Categories${catCount ? ` (${catCount})` : ""}</button>
        <button type="button" class="secondary" data-archive="${p.id}">${p.archived ? "Unarchive" : "Archive"}</button>
        <button type="button" class="danger" data-del-project="${p.id}">Delete</button>
      </li>`;
    })
    .join("");
}

function renderTimer() {
  const running = state.running;
  const btn = $("startStopBtn");
  if (running) {
    btn.textContent = "Stop";
    btn.classList.add("danger");
    btn.classList.remove("primary");
    $("timerProject").value = running.projectId;
    $("timerProject").disabled = true;
    $("timerNote").value = running.note || "";
    $("timerNote").disabled = true;
    // Show the locked-in category for the running session
    const p = projectById(running.projectId);
    if (p && (p.categories || []).length > 0) {
      $("timerCategory").hidden = false;
      $("timerCategory").innerHTML = categoryOptionsHTML(running.projectId, running.categoryId);
    } else {
      $("timerCategory").hidden = true;
    }
    $("timerCategory").disabled = true;
    $("timerDisplay").classList.add("running");
    if (!tickTimer) startTick();
  } else {
    btn.textContent = "Start";
    btn.classList.add("primary");
    btn.classList.remove("danger");
    $("timerProject").disabled = false;
    $("timerNote").disabled = false;
    $("timerCategory").disabled = false;
    refreshCategorySelect("timerCategory", $("timerProject").value);
    $("timerDisplay").classList.remove("running");
    renderTimerDisplay();
  }
}

function renderTimerDisplay() {
  if (state.running) {
    const elapsed = (Date.now() - new Date(state.running.start)) / 1000;
    $("timerDisplay").textContent = secToHMS(elapsed);
  } else {
    $("timerDisplay").textContent = "00:00:00";
  }
}

function totalsByProject(filterFn) {
  const totals = {};
  for (const e of state.entries) {
    if (filterFn && !filterFn(e)) continue;
    totals[e.projectId] = (totals[e.projectId] || 0) + (e.durationSec || 0);
  }
  return totals;
}

function periodFilter(period) {
  if (period === "all") return null;
  const now = new Date();
  let start;
  if (period === "today") {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === "week") {
    const day = (now.getDay() + 6) % 7; // Monday = 0
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
  } else if (period === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return (e) => {
    const d = entryDate(e);
    return d && new Date(d) >= start;
  };
}

function renderSummary() {
  const period = $("summaryPeriod").value;
  const totals = totalsByProject(periodFilter(period));
  const ul = $("summaryList");
  const rows = state.projects
    .map((p) => ({ p, sec: totals[p.id] || 0 }))
    .filter((r) => r.sec > 0)
    .sort((a, b) => b.sec - a.sec);
  if (!rows.length) {
    ul.innerHTML = `<li class="empty">No time tracked in this period.</li>`;
    return;
  }
  const grand = rows.reduce((sum, r) => sum + r.sec, 0);
  ul.innerHTML =
    rows
      .map(
        (r) => `<li>
          <span class="color-dot" style="background:${escapeAttr(r.p.color)}"></span>
          <span class="project-name">${escapeHTML(r.p.name)}</span>
          <span class="summary-total">${secToHM(r.sec)}</span>
        </li>`
      )
      .join("") +
    `<li><span class="color-dot" style="background:transparent"></span>
       <span class="project-name"><strong>Total</strong></span>
       <span class="summary-total"><strong>${secToHM(grand)}</strong></span></li>`;
}

function renderCategoryStats() {
  const projectId = $("catStatsProject").value;
  const period = $("catStatsPeriod").value;
  const ul = $("categoryStatsList");

  if (!projectId) {
    ul.innerHTML = `<li class="empty">Select a project to see its category breakdown.</li>`;
    return;
  }

  const p = projectById(projectId);
  if (!p) { ul.innerHTML = ""; return; }

  const cats = p.categories || [];
  const filterFn = periodFilter(period);
  const entries = state.entries.filter(
    (e) => e.projectId === projectId && (!filterFn || filterFn(e))
  );

  if (!entries.length) {
    ul.innerHTML = `<li class="empty">No time tracked for this project in this period.</li>`;
    return;
  }

  const totals = {};
  let otherSec = 0;
  for (const e of entries) {
    const cat = cats.find((c) => c.id === e.categoryId);
    if (cat) {
      totals[cat.id] = (totals[cat.id] || 0) + (e.durationSec || 0);
    } else {
      otherSec += e.durationSec || 0;
    }
  }

  const grand = entries.reduce((s, e) => s + (e.durationSec || 0), 0);

  const rows = cats
    .map((c) => ({ name: c.name, sec: totals[c.id] || 0 }))
    .filter((r) => r.sec > 0)
    .sort((a, b) => b.sec - a.sec);

  if (otherSec > 0) rows.push({ name: "Other", sec: otherSec });

  if (!rows.length) {
    ul.innerHTML = `<li class="empty">No time tracked for this project in this period.</li>`;
    return;
  }

  ul.innerHTML =
    rows
      .map((r) => {
        const pct = grand > 0 ? Math.round((r.sec / grand) * 100) : 0;
        return `<li class="cat-stat-row">
          <span class="cat-stat-name">${escapeHTML(r.name)}</span>
          <div class="cat-stat-bar-wrap">
            <div class="cat-stat-bar" style="width:${pct}%"></div>
          </div>
          <span class="cat-stat-pct">${pct}%</span>
          <span class="summary-total">${secToHM(r.sec)}</span>
        </li>`;
      })
      .join("") +
    `<li class="cat-stat-row">
      <span class="cat-stat-name"><strong>Total</strong></span>
      <div class="cat-stat-bar-wrap"></div>
      <span class="cat-stat-pct"></span>
      <span class="summary-total"><strong>${secToHM(grand)}</strong></span>
    </li>`;
}

function renderEntries() {
  const container = $("entryList");
  const entries = [...state.entries].sort((a, b) => {
    const da = entryDate(a) || "";
    const db = entryDate(b) || "";
    return db.localeCompare(da);
  });
  if (!entries.length) {
    container.innerHTML = `<p class="empty">No entries yet. Start the timer or add time manually.</p>`;
    return;
  }
  // Group by local day.
  const groups = new Map();
  for (const e of entries) {
    const d = entryDate(e);
    const key = d
      ? new Date(d).toLocaleDateString(undefined, {
          weekday: "short", year: "numeric", month: "short", day: "numeric",
        })
      : "Undated";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  let html = "";
  for (const [label, items] of groups) {
    const dayTotal = items.reduce((s, e) => s + (e.durationSec || 0), 0);
    html += `<div><div class="entry-day-label">${escapeHTML(label)} · ${secToHM(dayTotal)}</div>`;
    html += items
      .map((e) => {
        const p = projectById(e.projectId);
        const dot = p ? p.color : "#ccc";
        const name = p ? p.name : "(deleted project)";
        const cat = p && e.categoryId
          ? (p.categories || []).find((c) => c.id === e.categoryId)
          : null;
        return `<div class="entry-row">
          <span class="color-dot" style="background:${escapeAttr(dot)}"></span>
          <div class="entry-main">
            <div class="entry-project">
              ${escapeHTML(name)}
              ${cat ? `<span class="entry-cat-badge">${escapeHTML(cat.name)}</span>` : ""}
            </div>
            ${e.note ? `<div class="entry-note">${escapeHTML(e.note)}</div>` : ""}
          </div>
          <span class="entry-duration">${secToHM(e.durationSec || 0)}</span>
          <div class="entry-actions">
            <button type="button" class="secondary" data-edit="${e.id}">Edit</button>
            <button type="button" class="danger" data-del-entry="${e.id}">Delete</button>
          </div>
        </div>`;
      })
      .join("");
    html += `</div>`;
  }
  container.innerHTML = html;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHTML(s);
}

/* ---------------------------------------------------------------------------
 * 6. Events
 * ------------------------------------------------------------------------ */
function wireEvents() {
  // File controls
  $("openBtn").addEventListener("click", openFile);
  $("connectBtn").addEventListener("click", connectFile);
  $("reloadBtn").addEventListener("click", async () => {
    await readFile();
    renderAll();
  });
  $("exportBtn").addEventListener("click", exportJSON);
  $("importBtn").addEventListener("click", () => $("importInput").click());
  $("importInput").addEventListener("change", (e) => {
    if (e.target.files[0]) importJSON(e.target.files[0]);
    e.target.value = "";
  });

  // Timer: refresh category when project changes
  $("timerProject").addEventListener("change", () => {
    refreshCategorySelect("timerCategory", $("timerProject").value);
  });
  $("startStopBtn").addEventListener("click", () => {
    if (state.running) stopTimer();
    else startTimer($("timerProject").value, $("timerNote").value, $("timerCategory").value || null);
  });

  // Add project
  $("projectForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("projectName").value.trim();
    if (!name) return;
    addProject(name, $("projectColor").value);
    $("projectName").value = "";
  });

  // Project list actions (delegated)
  $("projectList").addEventListener("click", (e) => {
    const catsId = e.target.dataset.cats;
    const archiveId = e.target.dataset.archive;
    const delId = e.target.dataset.delProject;
    if (catsId) {
      openCategoriesDialog(catsId);
    } else if (archiveId) {
      const p = projectById(archiveId);
      setProjectArchived(archiveId, !(p && p.archived));
    } else if (delId) {
      deleteProject(delId);
    }
  });

  // Manual entry: refresh category when project changes
  $("manualProject").addEventListener("change", () => {
    refreshCategoryField("manualCategoryLabel", "manualCategory", $("manualProject").value);
  });
  $("manualDate").value = todayISODate();
  $("manualForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const projectId = $("manualProject").value;
    if (!projectId) { alert("Create a project first."); return; }
    const sec = parseHM($("manualDuration").value);
    if (sec === null || sec === 0) { alert("Enter a duration as hh:mm, e.g. 01:30."); return; }
    const date = $("manualDate").value;
    const start = new Date(date + "T12:00:00").toISOString();
    addEntry({
      projectId,
      start,
      end: null,
      durationSec: sec,
      note: $("manualNote").value,
      categoryId: $("manualCategory").value || null,
    });
    $("manualDuration").value = "";
    $("manualNote").value = "";
  });

  // Summary period
  $("summaryPeriod").addEventListener("change", renderSummary);

  // Category stats controls
  $("catStatsProject").addEventListener("change", renderCategoryStats);
  $("catStatsPeriod").addEventListener("change", renderCategoryStats);

  // Entry list actions (delegated)
  $("entryList").addEventListener("click", (e) => {
    const editId = e.target.dataset.edit;
    const delId = e.target.dataset.delEntry;
    if (editId) openEditDialog(editId);
    else if (delId) deleteEntry(delId);
  });

  // Edit dialog: refresh category when project changes
  $("editProject").addEventListener("change", () => {
    refreshCategoryField("editCategoryLabel", "editCategory", $("editProject").value, null);
  });
  $("editCancel").addEventListener("click", () => $("editDialog").close());
  $("editForm").addEventListener("submit", (e) => {
    e.preventDefault();
    saveEditDialog();
  });

  // Categories dialog
  $("addCatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("newCatName").value.trim();
    if (!name) return;
    addCategory(catDialogProjectId, name);
    $("newCatName").value = "";
    renderCatDialogList();
  });
  $("catDialogList").addEventListener("click", (e) => {
    const catId = e.target.dataset.delCat;
    if (catId) {
      deleteCategory(catDialogProjectId, catId);
      renderCatDialogList();
    }
  });
  $("closeCatDialogBtn").addEventListener("click", () => $("categoriesDialog").close());
}

/* ---------------------------------------------------------------------------
 * 6b. Edit dialog
 * ------------------------------------------------------------------------ */
let editingId = null;

function openEditDialog(id) {
  const e = state.entries.find((e) => e.id === id);
  if (!e) return;
  editingId = id;
  $("editProject").innerHTML = projectOptionsHTML(e.projectId);
  $("editProject").value = e.projectId;
  refreshCategoryField("editCategoryLabel", "editCategory", e.projectId, e.categoryId);
  const d = entryDate(e);
  $("editDate").value = d ? new Date(d).toISOString().slice(0, 10) : todayISODate();
  $("editDuration").value = secToHMInput(e.durationSec || 0);
  $("editNote").value = e.note || "";
  $("editDialog").showModal();
}

function saveEditDialog() {
  const e = state.entries.find((e) => e.id === editingId);
  if (!e) return;
  const sec = parseHM($("editDuration").value);
  if (sec === null) { alert("Enter a duration as hh:mm."); return; }
  const date = $("editDate").value;
  updateEntry(editingId, {
    projectId: $("editProject").value,
    durationSec: sec,
    note: $("editNote").value.trim(),
    categoryId: $("editCategory").value || null,
    start: new Date(date + "T12:00:00").toISOString(),
    end: null,
  });
  $("editDialog").close();
}

/* ---------------------------------------------------------------------------
 * 6c. Categories dialog
 * ------------------------------------------------------------------------ */
let catDialogProjectId = null;

function openCategoriesDialog(projectId) {
  const p = projectById(projectId);
  if (!p) return;
  catDialogProjectId = projectId;
  $("catDialogProjectName").textContent = p.name;
  $("newCatName").value = "";
  renderCatDialogList();
  $("categoriesDialog").showModal();
}

function renderCatDialogList() {
  const p = projectById(catDialogProjectId);
  if (!p) return;
  const ul = $("catDialogList");
  const cats = p.categories || [];
  if (!cats.length) {
    ul.innerHTML = `<li class="empty">No categories yet. Add one above.</li>`;
    return;
  }
  ul.innerHTML = cats
    .map(
      (c) => `<li>
        <span class="project-name">${escapeHTML(c.name)}</span>
        <button type="button" class="danger" data-del-cat="${c.id}">Delete</button>
      </li>`
    )
    .join("");
}

/* ---------------------------------------------------------------------------
 * 7. Init
 * ------------------------------------------------------------------------ */
async function init() {
  wireEvents();

  // Show the right persistence controls.
  if (!HAS_FS_ACCESS) {
    $("openBtn").hidden = true;
    $("connectBtn").hidden = true;
    $("exportBtn").hidden = false;
    $("importBtn").hidden = false;
    const saved = localStorage.getItem(LS_KEY);
    if (saved) {
      try { state = normalize(JSON.parse(saved)); } catch {}
    }
  } else {
    await tryRestoreHandle();
  }

  renderAll();
}

init();
