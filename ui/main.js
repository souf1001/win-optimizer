const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const CATEGORIES = {
  bloatware: "Bloatware",
  privacy: "Privacy",
  performance: "Performance",
  gaming: "Gaming",
  services: "Services",
  updates: "Updates",
  interface: "Interface",
  cleanup: "Cleanup",
};

const LEVELS = { light: "Light", medium: "Medium", aggressive: "Aggressive", optional: "Optional" };

const PRESETS = {
  light: { levels: ["light"], hint: "Light: safe changes nobody misses. Good for any PC." },
  medium: { levels: ["light", "medium"], hint: "Medium: Light, plus turning off features some people use (Copilot, Widgets, background apps)." },
  aggressive: { levels: ["light", "medium", "aggressive"], hint: "Aggressive: everything, including changes that trade security or features for speed. Read each one." },
};

const FIRST_RUN_HINT =
  "Pick a preset or select tweaks one by one. Nothing changes until you press Apply. Optional tweaks are personal taste and never part of a preset.";

const state = {
  tweaks: [],
  applied: null, // id -> bool once the status check finished, null while checking or after it failed
  backups: new Set(), // ids with saved original values
  statusError: false,
  warning: "",
  selected: new Set(loadSetting("selected", [])),
  hideApplied: loadSetting("hideApplied", false),
  open: new Set(),
  view: "all",
  query: "",
  running: false,
};

let statusRun = 0;
let runList = [];

const $ = (selector) => document.querySelector(selector);
const plural = (n) => `${n} ${n === 1 ? "tweak" : "tweaks"}`;

function escape(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function loadSetting(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveSettings() {
  try {
    localStorage.setItem("selected", JSON.stringify([...state.selected]));
    localStorage.setItem("hideApplied", JSON.stringify(state.hideApplied));
  } catch {}
}

const byId = (id) => state.tweaks.find((t) => t.id === id);
const isApplied = (t) => state.applied?.[t.id] === true;
const selectedTweaks = () => state.tweaks.filter((t) => state.selected.has(t.id));

// What Apply would change: skips tweaks that are already applied.
const toApply = (tweaks) => tweaks.filter((t) => !t.checkable || !isApplied(t));
// What Revert would change: tweaks that can be undone and are applied, or have saved values
// (a tweak that only partly applied still has something to restore).
const toRevert = (tweaks) => tweaks.filter((t) => t.reversible && (!t.checkable || isApplied(t) || state.backups.has(t.id)));
const checking = () => !state.applied && !state.statusError;

// Which preset matches the selection exactly, if any.
function activePreset() {
  return Object.keys(PRESETS).find((name) => {
    const levels = PRESETS[name].levels;
    return state.tweaks.every((t) => levels.includes(t.level) === state.selected.has(t.id));
  });
}

function visibleTweaks() {
  const query = state.query.trim().toLowerCase();
  return state.tweaks.filter((t) => {
    if (state.hideApplied && isApplied(t)) return false;
    if (query) return `${t.name} ${t.description} ${t.id}`.toLowerCase().includes(query);
    return state.view === "all" || t.category === state.view;
  });
}

const inCategory = () => state.view !== "all" && !state.query;

// Rendering

function render() {
  // The list is rebuilt from scratch, so remember what had focus.
  const focused = document.activeElement;
  const row = focused?.closest?.(".row")?.dataset.id;
  const part = focused?.classList?.contains("expand") ? ".expand" : "input";
  const group = focused?.dataset?.group;

  renderNav();
  renderHeader();
  renderList();
  renderBulkbar();

  if (row) document.querySelector(`.row[data-id="${CSS.escape(row)}"] ${part}`)?.focus();
  if (group) document.querySelector(`[data-group="${CSS.escape(group)}"]`)?.focus();
}

function renderNav() {
  const items = [["all", "All tweaks"], ...Object.entries(CATEGORIES)].map(([key, name]) => {
    const tweaks = key === "all" ? state.tweaks : state.tweaks.filter((t) => t.category === key);
    const picked = tweaks.filter((t) => state.selected.has(t.id)).length;
    const active = key === state.view && !state.query;
    return `<button class="nav-item${active ? " active" : ""}" data-view="${key}"${active ? ' aria-current="page"' : ""}>
      <span>${name}</span><span class="count">${picked ? `${picked}/` : ""}${tweaks.length}</span>
    </button>`;
  });
  $("#nav").innerHTML = items.join("");
}

function renderHeader() {
  const tweaks = visibleTweaks();
  const title = state.query ? (tweaks.length ? "Search results" : "No results") : state.view === "all" ? "All tweaks" : CATEGORIES[state.view];
  let subtitle = plural(tweaks.length);
  if (state.applied) subtitle += ` · ${tweaks.filter(isApplied).length} applied`;
  else subtitle += state.statusError ? " · status unknown" : " · checking status…";
  $("#title").textContent = title;
  $("#subtitle").textContent = subtitle;

  const preset = activePreset();
  for (const button of document.querySelectorAll("#presets button")) {
    button.setAttribute("aria-pressed", button.dataset.preset === preset);
    button.classList.toggle("active", button.dataset.preset === preset);
  }
  $("#preset-hint").textContent = preset ? PRESETS[preset].hint : state.selected.size ? "Custom selection. Pick a preset to start over." : FIRST_RUN_HINT;
  $("#warning").hidden = !state.warning;
  $("#warning").textContent = state.warning;
  $("#hide-applied").checked = state.hideApplied;
}

function renderList() {
  const tweaks = visibleTweaks();
  if (!state.tweaks.length) return;
  if (!tweaks.length) {
    $("#list").innerHTML = `<p class="empty">${state.query ? `No tweaks match "${escape(state.query)}".` : "Everything here is applied."}</p>`;
    return;
  }
  // Inside a category, group by level. Everywhere else, group by category.
  const key = inCategory() ? "level" : "category";
  const groups = inCategory() ? LEVELS : CATEGORIES;

  $("#list").innerHTML = Object.entries(groups)
    .map(([value, title]) => {
      const rows = tweaks.filter((t) => t[key] === value);
      if (!rows.length) return "";
      const picked = rows.filter((t) => state.selected.has(t.id)).length;
      return `<h2 class="section-title">
          <label><input type="checkbox" data-group="${value}" aria-label="Select all ${title}"${picked === rows.length ? " checked" : ""}${picked && picked < rows.length ? " data-mixed" : ""}>${title}</label>
          <span class="count">${rows.length}</span>
        </h2>
        <div class="group">${rows.map(renderRow).join("")}</div>`;
    })
    .join("");
  for (const box of document.querySelectorAll("[data-mixed]")) box.indeterminate = true;
}

function renderRow(t) {
  const open = state.open.has(t.id);
  const badge = inCategory() ? "" : `<span class="badge ${t.level}">${LEVELS[t.level]}</span>`;
  return `<div class="row${open ? " open" : ""}" data-id="${t.id}">
    <input type="checkbox" aria-labelledby="n-${t.id}" aria-describedby="d-${t.id}"${state.selected.has(t.id) ? " checked" : ""}>
    <div>
      <div class="row-title" id="n-${t.id}">${escape(t.name)} ${t.restart ? `<span class="tag">Restart</span>` : ""}</div>
      <div class="row-desc" id="d-${t.id}">${escape(t.description)}</div>
    </div>
    <span>${badge}</span>
    ${renderState(t)}
    <button class="expand" aria-label="Details for ${escape(t.name)}" aria-expanded="${open}">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    ${open ? renderDetails(t) : ""}
  </div>`;
}

function renderState(t) {
  if (!t.checkable) return `<span class="state">One-off</span>`;
  if (!state.applied) return `<span class="state">${state.statusError ? "Unknown" : "Checking…"}</span>`;
  return isApplied(t) ? `<span class="state applied">Applied</span>` : `<span class="state">Not applied</span>`;
}

// Shows exactly what a tweak changes.
function renderDetails(t) {
  const path = (p) => escape(p).replaceAll("\\", "\\<wbr>");
  const lines = [];
  for (const r of t.registry) {
    const revert = r.default === null ? "delete" : escape(r.default);
    lines.push(`<div><code>${path(r.path)}</code><br><code>${escape(r.name)} = ${escape(r.value)}</code> <span class="label">${escape(r.type)} · Windows default: ${revert}</span></div>`);
  }
  for (const s of t.services) {
    lines.push(`<div><span class="label">Service</span> <code>${escape(s.name)}</code> → ${escape(s.startup)} <span class="label">· Windows default: ${escape(s.default)}</span></div>`);
  }
  for (const task of t.tasks) {
    lines.push(`<div><span class="label">Disable task</span> <code>${path(task)}</code></div>`);
  }
  if (t.apps.length) lines.push(`<div><span class="label">Remove apps</span> <code>${t.apps.map(escape).join(", ")}</code></div>`);
  if (t.apply) lines.push(`<div><span class="label">Runs</span><pre>${escape(t.apply.trim())}</pre></div>`);
  lines.push(
    `<div class="label">${t.reversible ? "Revert restores the values you had before applying." : "Can't be undone from here."}</div>`,
  );
  return `<div class="details">${lines.join("")}</div>`;
}

function renderBulkbar() {
  const picked = selectedTweaks();
  $("#bulkbar").hidden = picked.length === 0;
  $("#refresh").disabled = state.running;
  if (!picked.length) return;
  const changes = toApply(picked);
  const info = [];
  if (state.applied) info.push(`${changes.length} to change`);
  const restart = changes.filter((t) => t.restart).length;
  const oneWay = changes.filter((t) => !t.reversible).length;
  if (restart) info.push(`${restart} need a restart`);
  if (oneWay) info.push(`${oneWay} can't be undone`);
  $("#selected-count").textContent = `${picked.length} selected`;
  $("#selected-info").textContent = info.join(" · ");
  $("#apply").disabled = state.running || checking() || !changes.length;
  $("#revert").disabled = state.running || checking() || !toRevert(picked).length;
}

// Running tweaks

function confirmRun(revert) {
  if (state.running || checking()) return;
  const picked = selectedTweaks();
  runList = revert ? toRevert(picked) : toApply(picked);
  if (!runList.length) return;

  const notes = [];
  const skipped = picked.length - runList.length;
  if (revert) {
    notes.push({ text: `Restores the values you had before for ${plural(runList.length)}.` });
    if (skipped) notes.push({ text: `${plural(skipped)} skipped: not applied, or can't be undone.` });
  } else {
    const aggressive = runList.filter((t) => t.level === "aggressive").length;
    const oneWay = runList.filter((t) => !t.reversible).length;
    const restart = runList.filter((t) => t.restart).length;
    if (aggressive) notes.push({ text: `${aggressive} aggressive. Check their descriptions first.`, warn: true });
    if (oneWay) notes.push({ text: `${oneWay} can't be undone (app removal and cleanup).` });
    if (restart) notes.push({ text: `${restart} take effect after a restart.` });
    if (skipped) notes.push({ text: `${plural(skipped)} already applied and skipped.` });
    notes.push({ text: "Explorer restarts at the end, so the taskbar flickers once." });
  }
  $("#confirm-title").textContent = `${revert ? "Revert" : "Apply"} ${plural(runList.length)}?`;
  $("#confirm-notes").innerHTML = notes.map((n) => `<li${n.warn ? ' class="warn"' : ""}>${escape(n.text)}</li>`).join("");
  $("#confirm-ok").textContent = revert ? "Revert" : "Apply";
  $("#confirm-ok").dataset.mode = revert ? "revert" : "apply";
  $("#confirm").hidden = false;
  $("#progress").hidden = true;
  $("#dialog").setAttribute("aria-labelledby", "confirm-title");
  $("#dialog").showModal();
  $("#confirm-ok").focus();
}

async function run(revert) {
  const ids = runList.map((t) => t.id);
  const restorePoint = $("#restore-point").checked;
  const total = ids.length + (restorePoint ? 1 : 0);
  const verb = revert ? "Reverting" : "Applying";
  let finished = 0;

  state.running = true;
  render();
  $("#confirm").hidden = true;
  $("#progress").hidden = false;
  $("#dialog").setAttribute("aria-labelledby", "progress-title");
  $("#progress-title").textContent = `${verb}…`;
  $("#progress-close").disabled = true;
  $("#restart").hidden = true;
  $("#restart").disabled = false;
  $("#log").innerHTML = "";
  setProgress(0);

  const nameOf = (id) => (id === "restore-point" ? "Create restore point" : byId(id)?.name ?? id);
  const log = (item, className, mark, text) => {
    item ??= $("#log").appendChild(document.createElement("li"));
    item.className = className;
    item.innerHTML = `<span class="mark">${mark}</span><span>${escape(text)}</span>`;
    item.scrollIntoView({ block: "nearest" });
    return item;
  };
  const lines = {};

  const unlisten = await listen("log", ({ payload }) => {
    const [kind, ...rest] = payload.split(":");
    const text = rest.join(":");
    if (kind === "run") {
      lines[text] = log(null, "", "·", nameOf(text));
    } else if (kind === "done" || kind === "skip" || kind === "fail") {
      const [id, ...message] = text.split(":");
      finished += 1;
      setProgress(finished / total);
      $("#progress-title").textContent = `${verb} ${Math.min(finished + 1, total)} of ${total}…`;
      if (kind === "done") log(lines[id], "ok", "✓", nameOf(id));
      else if (kind === "skip") log(lines[id], "skipped", "–", `${nameOf(id)}: ${message.join(":")}`);
      else log(lines[id], "fail", "✕", `${nameOf(id)}: ${message.join(":")}`);
    } else if (kind === "log") {
      log(null, "output", "", text);
    }
  });

  try {
    const outcomes = await invoke("run_tweaks", { ids, revert, restorePoint });
    const restoreFailed = outcomes.some((o) => o.id === "restore-point" && !o.ok);
    const done = outcomes.filter((o) => o.ok && !o.skipped && o.id !== "restore-point");
    const skipped = outcomes.filter((o) => o.skipped).length;
    // Anything without an outcome never ran, for example because the script stopped early.
    const failed = ids.length - done.length - skipped;
    if (restoreFailed) {
      $("#progress-title").textContent = "The restore point failed, so nothing was changed.";
    } else {
      let title = `${revert ? "Reverted" : "Applied"} ${plural(done.length)}`;
      if (skipped) title += `, ${skipped} skipped`;
      if (failed) title += `, ${failed} failed`;
      const needsRestart = done.some((o) => byId(o.id)?.restart);
      if (needsRestart) title += ". Restart to finish.";
      $("#progress-title").textContent = title;
      $("#restart").hidden = !needsRestart;
    }
  } catch (error) {
    $("#progress-title").textContent = "Something went wrong";
    log(null, "fail", "✕", String(error));
  } finally {
    unlisten();
    setProgress(1);
    state.running = false;
    $("#progress-close").disabled = false;
    $("#log .fail")?.scrollIntoView({ block: "nearest" });
    $("#progress-close").focus();
    refreshStatus();
  }
}

function setProgress(fraction) {
  $("#bar-fill").style.width = `${fraction * 100}%`;
  $(".bar").setAttribute("aria-valuenow", Math.round(fraction * 100));
}

async function refreshStatus() {
  if (state.running) return;
  const current = ++statusRun;
  state.applied = null;
  state.statusError = false;
  render();
  try {
    const status = await invoke("get_status");
    if (current !== statusRun) return;
    state.applied = status.applied;
    state.backups = new Set(status.backups);
    state.warning = status.warning;
    $("#system").textContent = status.system;
  } catch (error) {
    if (current !== statusRun) return;
    state.statusError = true;
    $("#system").textContent = `Status check failed: ${error}`;
  }
  render();
}

// Events

$("#nav").addEventListener("click", (event) => {
  const item = event.target.closest(".nav-item");
  if (!item) return;
  state.view = item.dataset.view;
  state.query = "";
  $("#search").value = "";
  render();
  $("#scroll").scrollTop = 0;
});

$("#list").addEventListener("click", (event) => {
  const group = event.target.closest("[data-group]");
  if (group) {
    const key = inCategory() ? "level" : "category";
    const rows = visibleTweaks().filter((t) => t[key] === group.dataset.group);
    const selectAll = rows.some((t) => !state.selected.has(t.id));
    for (const t of rows) selectAll ? state.selected.add(t.id) : state.selected.delete(t.id);
    saveSettings();
    render();
    return;
  }
  const row = event.target.closest(".row");
  if (!row || event.target.closest(".details")) return;
  const id = row.dataset.id;
  const set = event.target.closest(".expand") ? state.open : state.selected;
  set.has(id) ? set.delete(id) : set.add(id);
  saveSettings();
  render();
});

$("#presets").addEventListener("click", (event) => {
  const name = event.target.dataset.preset;
  if (!name) return;
  const levels = PRESETS[name].levels;
  state.selected = new Set(state.tweaks.filter((t) => levels.includes(t.level)).map((t) => t.id));
  saveSettings();
  render();
});

$("#search").addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

$("#hide-applied").addEventListener("change", (event) => {
  state.hideApplied = event.target.checked;
  saveSettings();
  render();
});

document.addEventListener("keydown", (event) => {
  const typing = document.activeElement === $("#search");
  if ($("#dialog").open) return;
  if ((event.key === "/" && !typing) || (event.key === "k" && event.ctrlKey)) {
    event.preventDefault();
    $("#search").focus();
  } else if (event.key === "Escape" && typing) {
    $("#search").value = "";
    state.query = "";
    $("#search").blur();
    render();
  } else if (event.key === "Enter" && event.ctrlKey && !$("#apply").disabled && !$("#bulkbar").hidden) {
    confirmRun(false);
  }
});

$("#clear").addEventListener("click", () => {
  state.selected.clear();
  saveSettings();
  render();
});

$("#apply").addEventListener("click", () => confirmRun(false));
$("#revert").addEventListener("click", () => confirmRun(true));
$("#refresh").addEventListener("click", refreshStatus);
$("#progress-close").addEventListener("click", () => $("#dialog").close());

$("#restart").addEventListener("click", async () => {
  $("#restart").disabled = true;
  try {
    await invoke("restart_pc");
    $("#progress-title").textContent = "Restarting…";
  } catch (error) {
    $("#restart").disabled = false;
    $("#progress-title").textContent = `Could not restart: ${error}`;
  }
});

$("#confirm").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "ok") return;
  event.preventDefault();
  run(event.submitter.dataset.mode === "revert");
});

// Keep the dialog open while tweaks run. WebView2 may still close it on a repeated Escape,
// so reopen it in that case.
$("#dialog").addEventListener("cancel", (event) => {
  if (state.running) event.preventDefault();
});
$("#dialog").addEventListener("close", () => {
  if (state.running) $("#dialog").showModal();
});

async function start() {
  try {
    state.tweaks = await invoke("list_tweaks");
  } catch (error) {
    $("#list").innerHTML = `<p class="empty">Couldn't load tweaks: ${escape(error)}</p>`;
    return;
  }
  const known = new Set(state.tweaks.map((t) => t.id));
  state.selected = new Set([...state.selected].filter((id) => known.has(id)));
  render();
  refreshStatus();
}

start();
