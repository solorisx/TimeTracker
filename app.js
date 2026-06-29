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

// --- Google Drive config (see config.js + README "Google Drive setup") ---
const GOOGLE_CLIENT_ID = (window.TT_CONFIG && window.TT_CONFIG.googleClientId) || "";
const DRIVE_ENABLED = !!GOOGLE_CLIENT_ID;
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FILE_NAME = "timetracker.json";
const LS_DRIVE_FILE_ID = "timetracker.driveFileId";

let state = emptyState();
let fileHandle = null;     // FileSystemFileHandle when connected (FS Access mode)
let pendingHandle = null;  // handle retrieved from IDB that still needs permission (mobile reload)
let openedFileName = null; // name of file opened via <input type="file"> (no write handle)
let saveTimer = null;      // debounce handle for saving
let tickTimer = null;      // setInterval for the live timer display

// Google Drive runtime state
let tokenClient = null;    // GIS token client
let driveToken = null;     // current OAuth access token
let driveFileId = null;    // Drive file id when connected
let driveNeedsAuth = false; // true when a stored file exists but silent auth failed

function emptyState() {
  return { version: 1, projects: [], entries: [], running: null };
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
  const current = await handle.queryPermission(opts);
  console.log("[TT] ensurePermission queryPermission:", current, handle.name);
  if (current === "granted") return true;
  const requested = await handle.requestPermission(opts);
  console.log("[TT] ensurePermission requestPermission:", requested, handle.name);
  return requested === "granted";
}

// --- Connect (create or open) a data file ---
async function connectFile() {
  try {
    let handle;
    // Default to creating/picking a file named timetracker.json.
    handle = await window.showSaveFilePicker({
      suggestedName: "timetracker.json",
      types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
    });
    console.log("[TT] connectFile: picked", handle.name, handle.kind);
    fileHandle = handle;
    openedFileName = null;
    try {
      await idbSet(IDB_HANDLE_KEY, handle);
      console.log("[TT] connectFile: handle saved to IDB");
    } catch (idbErr) {
      console.warn("[TT] connectFile: IDB save failed (remote fs?):", idbErr);
    }

    // If the file already has content, load it; otherwise write current state.
    const file = await handle.getFile();
    const text = (await file.text()).trim();
    console.log("[TT] connectFile: file size", file.size, "text length", text.length);
    if (text) {
      state = normalize(JSON.parse(text));
    } else {
      await writeFile();
    }
    renderAll();
  } catch (err) {
    if (err && err.name === "AbortError") return; // user cancelled
    console.error("[TT] connectFile error:", err);
    alert("Could not connect the data file: " + err.message);
  }
}

// --- Open an existing data file ---
// Uses <input type="file"> instead of showOpenFilePicker so it works on
// remote/virtual filesystems (Google Drive FUSE mounts, etc.) where
// showOpenFilePicker hangs silently in Chrome on Linux.
function openFile() {
  $("openInput").click();
}

function handleOpenInput(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  console.log("[TT] handleOpenInput: reading", file.name, "size", file.size);
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = reader.result.trim();
      console.log("[TT] handleOpenInput: text length", text.length);
      state = text ? normalize(JSON.parse(text)) : emptyState();
      openedFileName = file.name;
      fileHandle = null; // no write handle — saves go to localStorage
      console.log("[TT] handleOpenInput: loaded", state.projects.length, "projects,", state.entries.length, "entries");
      persist();
      renderAll();
    } catch (err) {
      alert("Could not load file: " + err.message);
    }
  };
  reader.readAsText(file);
}

// --- Reconnect to a previously stored handle on startup ---
async function tryRestoreHandle() {
  if (!HAS_FS_ACCESS) return false;
  try {
    const handle = await idbGet(IDB_HANDLE_KEY);
    console.log("[TT] tryRestoreHandle: IDB handle", handle ? handle.name : "none");
    if (!handle) return false;
    // queryPermission never needs a user gesture; requestPermission does.
    // On mobile, requestPermission during init will fail without a touch event,
    // so only proceed automatically when permission is already granted.
    const perm = await handle.queryPermission({ mode: "readwrite" });
    console.log("[TT] tryRestoreHandle: queryPermission", perm);
    if (perm === "granted") {
      fileHandle = handle;
      await readFile();
      return true;
    }
    // Permission needs a user gesture — surface the reconnect button instead.
    pendingHandle = handle;
    return false;
  } catch (err) {
    console.warn("[TT] tryRestoreHandle error:", err);
    return false;
  }
}

// --- Re-request permission via user gesture (tap on mobile) ---
async function reconnectFile() {
  if (!pendingHandle) return;
  try {
    console.log("[TT] reconnectFile: requesting permission for", pendingHandle.name);
    if (!(await ensurePermission(pendingHandle))) {
      console.warn("[TT] reconnectFile: permission denied");
      return;
    }
    fileHandle = pendingHandle;
    pendingHandle = null;
    openedFileName = null;
    await readFile();
    renderAll();
  } catch (err) {
    console.warn("[TT] reconnectFile error:", err);
  }
}

// --- Read current state from the connected file ---
async function readFile() {
  if (!fileHandle) { console.warn("[TT] readFile: no fileHandle"); return; }
  console.log("[TT] readFile: reading", fileHandle.name);
  const file = await fileHandle.getFile();
  console.log("[TT] readFile: file size", file.size, "lastModified", new Date(file.lastModified).toISOString());
  const text = (await file.text()).trim();
  console.log("[TT] readFile: text length", text.length, text ? "parsing JSON" : "empty → emptyState");
  state = text ? normalize(JSON.parse(text)) : emptyState();
  console.log("[TT] readFile: loaded", state.projects.length, "projects,", state.entries.length, "entries");
}

// --- Write current state to the connected file (FS Access mode) ---
async function writeFile() {
  if (!fileHandle) return;
  console.log("[TT] writeFile:", fileHandle.name);
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(state, null, 2));
  await writable.close();
}

/* ---------------------------------------------------------------------------
 * 1b. Google Drive storage (works on desktop + mobile, survives reload)
 * ------------------------------------------------------------------------ */

// Resolve once the Google Identity Services script has loaded.
function whenGisReady(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (window.google && google.accounts && google.accounts.oauth2) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("Google sign-in library failed to load"));
      setTimeout(check, 100);
    })();
  });
}

// Request an access token. prompt: undefined => GIS decides; "" => silent (no UI).
// Resolution is routed through tokenWaiters because GIS captures the success
// and error callbacks at initTokenClient() time (see ensureTokenClient).
let tokenWaiters = null;
function requestToken(prompt) {
  return new Promise((resolve, reject) => {
    if (!tokenClient) return reject(new Error("Drive not configured"));
    tokenWaiters = { resolve, reject };
    tokenClient.requestAccessToken(prompt === undefined ? {} : { prompt });
  });
}

// fetch wrapper that attaches the token and refreshes once on 401.
async function driveFetch(url, opts = {}, retried = false) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: "Bearer " + driveToken },
  });
  if (res.status === 401 && !retried) {
    console.log("[TT] driveFetch: 401, refreshing token");
    await requestToken("");
    return driveFetch(url, opts, true);
  }
  return res;
}

// Build a descriptive Error from a failed Drive response, including Google's
// own message (e.g. "Google Drive API has not been used in project N …") and
// the activation URL it returns, so the cause is actionable.
async function driveError(res, label) {
  let detail = "";
  try {
    const body = await res.json();
    if (body && body.error) {
      detail = body.error.message || "";
      const help = body.error.errors && body.error.errors[0] && body.error.errors[0].extendedHelp;
      if (help) detail += "\n" + help;
    }
  } catch { /* non-JSON body */ }
  console.error("[TT]", label, res.status, detail);
  return new Error(`${label} (${res.status})` + (detail ? ": " + detail : ""));
}

async function driveFindFile() {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const res = await driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`
  );
  if (!res.ok) throw await driveError(res, "Drive search failed");
  const data = await res.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

async function driveCreateFile() {
  const boundary = "ttb" + Math.random().toString(16).slice(2);
  const meta = { name: DRIVE_FILE_NAME, mimeType: "application/json" };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(state, null, 2)}\r\n` +
    `--${boundary}--`;
  const res = await driveFetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
    { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }
  );
  if (!res.ok) throw await driveError(res, "Drive create failed");
  const data = await res.json();
  return data.id;
}

async function driveRead() {
  if (!driveFileId) return;
  console.log("[TT] driveRead:", driveFileId);
  const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}?alt=media`);
  if (!res.ok) throw await driveError(res, "Drive read failed");
  const text = (await res.text()).trim();
  console.log("[TT] driveRead: text length", text.length);
  state = text ? normalize(JSON.parse(text)) : emptyState();
}

async function driveWrite() {
  if (!driveFileId) return;
  console.log("[TT] driveWrite:", driveFileId);
  const res = await driveFetch(
    `https://www.googleapis.com/upload/drive/v3/files/${driveFileId}?uploadType=media`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state, null, 2) }
  );
  if (!res.ok) throw await driveError(res, "Drive write failed");
}

// Connect to Drive from a user gesture (button click): authorize, then
// find-or-create the data file and load it.
async function connectDrive() {
  try {
    await ensureTokenClient();
    console.log("[TT] connectDrive: requesting token");
    await requestToken();
    let id = localStorage.getItem(LS_DRIVE_FILE_ID);
    if (id) {
      const check = await driveFetch(`https://www.googleapis.com/drive/v3/files/${id}?fields=id`);
      if (!check.ok) { console.log("[TT] connectDrive: stored id invalid, re-searching"); id = null; }
    }
    if (!id) id = await driveFindFile();
    if (!id) { console.log("[TT] connectDrive: creating new file"); id = await driveCreateFile(); }
    driveFileId = id;
    localStorage.setItem(LS_DRIVE_FILE_ID, id);
    driveNeedsAuth = false;
    // Drive takes over: clear local-file modes.
    fileHandle = null;
    pendingHandle = null;
    openedFileName = null;
    await driveRead();
    renderAll();
    console.log("[TT] connectDrive: connected, file", id);
  } catch (err) {
    console.error("[TT] connectDrive error:", err);
    if (err && (err.type === "popup_closed" || err.type === "popup_failed_to_open")) return;
    alert("Could not connect Google Drive: " + (err.message || err.type || "unknown error"));
  }
}

// On startup: if a Drive file was used before, try a silent token so the
// connection is restored without a click. If silent auth needs UI, surface
// a button instead (same pattern as the mobile reconnect flow).
async function tryRestoreDrive() {
  if (!DRIVE_ENABLED) return false;
  const id = localStorage.getItem(LS_DRIVE_FILE_ID);
  if (!id) return false;
  try {
    await ensureTokenClient();
    console.log("[TT] tryRestoreDrive: attempting silent token");
    await requestToken("");
    driveFileId = id;
    driveNeedsAuth = false;
    await driveRead();
    console.log("[TT] tryRestoreDrive: restored");
    return true;
  } catch (err) {
    console.log("[TT] tryRestoreDrive: silent auth failed, will show button", err && (err.type || err.message));
    driveNeedsAuth = true;
    return false;
  }
}

/* ---------------------------------------------------------------------------
 * 1c. Persist: debounced; routes to Drive, local file, or localStorage
 * ------------------------------------------------------------------------ */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 300);
}

async function persist() {
  try {
    if (driveFileId) {
      await driveWrite();
    } else if (fileHandle) {
      await writeFile();
    } else {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    }
  } catch (err) {
    console.error("[TT] persist failed:", err);
  }
}

// --- Normalize loaded data so missing fields don't break the app ---
function normalize(data) {
  const s = emptyState();
  if (data && typeof data === "object") {
    if (Array.isArray(data.projects)) s.projects = data.projects;
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

function addEntry({ projectId, start, end, durationSec, note }) {
  state.entries.push({
    id: crypto.randomUUID(),
    projectId,
    start: start || null,
    end: end || null,
    durationSec,
    note: (note || "").trim(),
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

/* ---------------------------------------------------------------------------
 * 4. Timer
 * ------------------------------------------------------------------------ */
function startTimer(projectId, note) {
  if (!projectId) { alert("Create and select a project first."); return; }
  state.running = { projectId, start: new Date().toISOString(), note: (note || "").trim() };
  commit();
  startTick();
}

function stopTimer() {
  if (!state.running) return;
  const start = new Date(state.running.start);
  const end = new Date();
  const durationSec = Math.max(1, Math.round((end - start) / 1000));
  const { projectId, note } = state.running;
  state.running = null;
  // addEntry calls commit(); render clears the running display.
  addEntry({ projectId, start: start.toISOString(), end: end.toISOString(), durationSec, note });
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
  renderEntries();
}

function renderFileStatus() {
  const status = $("fileStatus");
  let text, connected = false, reload = false, reconnect = false, drive = false;

  if (driveFileId) {
    text = "Google Drive — synced (" + DRIVE_FILE_NAME + ")";
    connected = true;
    reload = true;
  } else if (driveNeedsAuth) {
    text = "Google Drive — tap to reconnect";
    drive = true;
  } else if (fileHandle) {
    text = "Connected: " + fileHandle.name;
    connected = true;
    reload = true;
  } else if (pendingHandle) {
    text = "Tap to reconnect: " + pendingHandle.name;
    reconnect = true;
  } else if (openedFileName) {
    text = "Loaded: " + openedFileName + " — changes saved locally";
  } else if (HAS_FS_ACCESS) {
    text = "Not connected — using temporary storage";
    drive = DRIVE_ENABLED;
  } else {
    text = "Browser storage (use Export to back up)";
    drive = DRIVE_ENABLED;
  }

  status.textContent = text;
  status.classList.toggle("connected", connected);
  $("reloadBtn").hidden = !reload;
  $("reconnectBtn").hidden = !reconnect;
  $("driveBtn").hidden = !drive;
}

function projectOptionsHTML(selectedId) {
  return state.projects
    .filter((p) => !p.archived)
    .map((p) => `<option value="${p.id}"${p.id === selectedId ? " selected" : ""}>${escapeHTML(p.name)}</option>`)
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
      return `<li class="${p.archived ? "archived" : ""}">
        <span class="color-dot" style="background:${escapeAttr(p.color)}"></span>
        <span class="project-name">${escapeHTML(p.name)}</span>
        <span class="project-total">${total}</span>
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
    $("timerDisplay").classList.add("running");
    if (!tickTimer) startTick();
  } else {
    btn.textContent = "Start";
    btn.classList.add("primary");
    btn.classList.remove("danger");
    $("timerProject").disabled = false;
    $("timerNote").disabled = false;
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
    const key = d ? new Date(d).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" }) : "Undated";
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
        return `<div class="entry-row">
          <span class="color-dot" style="background:${escapeAttr(dot)}"></span>
          <div class="entry-main">
            <div class="entry-project">${escapeHTML(name)}</div>
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
  $("openInput").addEventListener("change", handleOpenInput);
  $("connectBtn").addEventListener("click", connectFile);
  $("reconnectBtn").addEventListener("click", reconnectFile);
  $("driveBtn").addEventListener("click", connectDrive);
  $("reloadBtn").addEventListener("click", async () => {
    if (driveFileId) await driveRead();
    else await readFile();
    renderAll();
  });
  $("exportBtn").addEventListener("click", exportJSON);
  $("importBtn").addEventListener("click", () => $("importInput").click());
  $("importInput").addEventListener("change", (e) => {
    if (e.target.files[0]) importJSON(e.target.files[0]);
    e.target.value = "";
  });

  // Timer
  $("startStopBtn").addEventListener("click", () => {
    if (state.running) stopTimer();
    else startTimer($("timerProject").value, $("timerNote").value);
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
    const archiveId = e.target.dataset.archive;
    const delId = e.target.dataset.delProject;
    if (archiveId) {
      const p = projectById(archiveId);
      setProjectArchived(archiveId, !(p && p.archived));
    } else if (delId) {
      deleteProject(delId);
    }
  });

  // Manual entry
  $("manualDate").value = todayISODate();
  $("manualForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const projectId = $("manualProject").value;
    if (!projectId) { alert("Create a project first."); return; }
    const sec = parseHM($("manualDuration").value);
    if (sec === null || sec === 0) { alert("Enter a duration as hh:mm, e.g. 01:30."); return; }
    const date = $("manualDate").value;
    // Anchor manual entries at noon local time on the chosen date.
    const start = new Date(date + "T12:00:00").toISOString();
    addEntry({ projectId, start, end: null, durationSec: sec, note: $("manualNote").value });
    $("manualDuration").value = "";
    $("manualNote").value = "";
  });

  // Summary period
  $("summaryPeriod").addEventListener("change", renderSummary);

  // Entry list actions (delegated)
  $("entryList").addEventListener("click", (e) => {
    const editId = e.target.dataset.edit;
    const delId = e.target.dataset.delEntry;
    if (editId) openEditDialog(editId);
    else if (delId) deleteEntry(delId);
  });

  // Edit dialog
  $("editCancel").addEventListener("click", () => $("editDialog").close());
  $("editForm").addEventListener("submit", (e) => {
    e.preventDefault();
    saveEditDialog();
  });
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
    start: new Date(date + "T12:00:00").toISOString(),
    end: null,
  });
  $("editDialog").close();
}

/* ---------------------------------------------------------------------------
 * 7. Init
 * ------------------------------------------------------------------------ */
// Initialise the GIS token client. Safe to call repeatedly; no-op if ready.
async function ensureTokenClient() {
  if (tokenClient) return;
  await whenGisReady();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (resp) => {
      const w = tokenWaiters;
      tokenWaiters = null;
      if (!w) return;
      if (resp && resp.error) return w.reject(resp);
      driveToken = resp.access_token;
      w.resolve(resp.access_token);
    },
    error_callback: (err) => {
      const w = tokenWaiters;
      tokenWaiters = null;
      if (w) w.reject(err);
    },
  });
}

async function init() {
  wireEvents();
  if (!DRIVE_ENABLED) $("driveBtn").hidden = true;

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

  // Render immediately so a slow/blocked Google script never delays the UI.
  renderAll();

  // Restore the Drive connection (if previously used) in the background.
  if (DRIVE_ENABLED) {
    ensureTokenClient()
      .then(() => tryRestoreDrive())
      .catch((err) => console.warn("[TT] Drive init failed:", err))
      .finally(() => renderAll());
  }
}

init();
