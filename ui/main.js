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

const state = {
  tweaks: [],
  applied: {},
  checked: false,
  selected: new Set(loadSelection()),
  open: new Set(),
  view: "all",
  query: "",
};

const $ = (selector) => document.querySelector(selector);

function escape(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function loadSelection() {
  try {
    return JSON.parse(localStorage.getItem("selected")) ?? [];
  } catch {
    return [];
  }
}

function saveSelection() {
  try {
    localStorage.setItem("selected", JSON.stringify([...state.selected]));
  } catch {}
}

function byId(id) {
  return state.tweaks.find((t) => t.id === id);
}

function selectedTweaks() {
  return state.tweaks.filter((t) => state.selected.has(t.id));
}

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
    if (query) return `${t.name} ${t.description} ${t.id}`.toLowerCase().includes(query);
    return state.view === "all" || t.category === state.view;
  });
}

// Rendering

function render() {
  renderNav();
  renderHeader();
  renderList();
  renderBulkbar();
}

function renderNav() {
  const items = [["all", "All tweaks"], ...Object.entries(CATEGORIES)].map(([key, name]) => {
    const tweaks = key === "all" ? state.tweaks : state.tweaks.filter((t) => t.category === key);
    const picked = tweaks.filter((t) => state.selected.has(t.id)).length;
    const active = key === state.view && !state.query ? " active" : "";
    return `<button class="nav-item${active}" data-view="${key}">
      <span>${name}</span><span class="count">${picked ? `${picked}/` : ""}${tweaks.length}</span>
    </button>`;
  });
  $("#nav").innerHTML = items.join("");
}

function renderHeader() {
  const tweaks = visibleTweaks();
  const applied = tweaks.filter((t) => state.applied[t.id]).length;
  $("#title").textContent = state.query ? "Search" : state.view === "all" ? "All tweaks" : CATEGORIES[state.view];
  $("#subtitle").textContent = `${tweaks.length} tweaks` + (state.checked ? ` · ${applied} applied` : "");

  const preset = activePreset();
  for (const button of document.querySelectorAll("#presets button")) {
    button.classList.toggle("active", button.dataset.preset === preset);
  }
  $("#preset-hint").textContent = preset
    ? PRESETS[preset].hint
    : state.selected.size
      ? "Custom selection. Pick a preset to start over."
      : "Pick a preset, or select tweaks one by one.";
}

function renderList() {
  const tweaks = visibleTweaks();
  if (!tweaks.length) {
    $("#list").innerHTML = `<p class="empty">No tweaks match "${escape(state.query)}".</p>`;
    return;
  }
  // Inside a category, group by level. Everywhere else, group by category.
  const inCategory = state.view !== "all" && !state.query;
  const groups = inCategory ? LEVELS : CATEGORIES;
  const key = inCategory ? "level" : "category";

  $("#list").innerHTML = Object.entries(groups)
    .map(([value, title]) => {
      const rows = tweaks.filter((t) => t[key] === value);
      if (!rows.length) return "";
      return `<h2 class="section-title">${title}</h2><div class="group">${rows.map(renderRow).join("")}</div>`;
    })
    .join("");
}

function renderRow(t) {
  const open = state.open.has(t.id);
  return `<div class="row${open ? " open" : ""}" data-id="${t.id}" tabindex="0">
    <input type="checkbox" tabindex="-1" ${state.selected.has(t.id) ? "checked" : ""} aria-label="Select">
    <div>
      <div class="row-title">${escape(t.name)}${t.restart ? `<span class="tag">Restart</span>` : ""}</div>
      <div class="row-desc">${escape(t.description)}</div>
    </div>
    <span class="badge ${t.level}">${LEVELS[t.level]}</span>
    ${renderState(t)}
    <button class="expand" aria-label="Details" aria-expanded="${open}">
      <svg width="16" height="16" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    ${open ? renderDetails(t) : ""}
  </div>`;
}

function renderState(t) {
  if (!t.checkable) return `<span class="state">One-off</span>`;
  if (!state.checked) return `<span class="state">Checking…</span>`;
  return state.applied[t.id] ? `<span class="state applied">Applied</span>` : `<span class="state">Not applied</span>`;
}

// Shows exactly what a tweak changes.
function renderDetails(t) {
  const lines = [];
  for (const r of t.registry) {
    const revert = r.default === null ? "delete" : escape(r.default);
    lines.push(`<div><code>${escape(r.path)}</code><br><code>${escape(r.name)} = ${escape(r.value)}</code> <span class="label">${r.type} · revert: ${revert}</span></div>`);
  }
  for (const s of t.services) {
    lines.push(`<div><span class="label">Service</span> <code>${escape(s.name)}</code> → ${s.startup} <span class="label">· revert: ${s.default}</span></div>`);
  }
  for (const task of t.tasks) {
    lines.push(`<div><span class="label">Disable task</span> <code>${escape(task)}</code></div>`);
  }
  if (t.apps.length) {
    lines.push(`<div><span class="label">Remove apps</span> <code>${t.apps.map(escape).join(", ")}</code></div>`);
  }
  if (t.apply) lines.push(`<div><span class="label">Runs</span><pre>${escape(t.apply.trim())}</pre></div>`);
  if (!t.reversible) lines.push(`<div class="label">Can't be undone from here.</div>`);
  return `<div class="details">${lines.join("")}</div>`;
}

function renderBulkbar() {
  const picked = selectedTweaks();
  $("#bulkbar").hidden = picked.length === 0;
  if (!picked.length) return;
  const restart = picked.filter((t) => t.restart).length;
  const oneWay = picked.filter((t) => !t.reversible).length;
  const info = [];
  if (restart) info.push(`${restart} need a restart`);
  if (oneWay) info.push(`${oneWay} can't be undone`);
  $("#selected-count").textContent = `${picked.length} selected`;
  $("#selected-info").textContent = info.join(" · ");
  $("#revert").disabled = !picked.some((t) => t.reversible);
}

// Running tweaks

let mode = "apply";

function confirmRun(revert) {
  mode = revert ? "revert" : "apply";
  const picked = selectedTweaks().filter((t) => !revert || t.reversible);
  const notes = [];
  if (revert) {
    notes.push(`Restores the Windows defaults for ${picked.length} tweaks.`);
    const skipped = state.selected.size - picked.length;
    if (skipped) notes.push(`${skipped} selected tweaks can't be undone and are skipped.`);
  } else {
    const aggressive = picked.filter((t) => t.level === "aggressive").length;
    const oneWay = picked.filter((t) => !t.reversible).length;
    const restart = picked.filter((t) => t.restart).length;
    if (aggressive) notes.push(`<li class="warn">${aggressive} aggressive tweaks. Check their descriptions first.</li>`);
    if (oneWay) notes.push(`${oneWay} can't be undone (app removal and cleanup).`);
    if (restart) notes.push(`${restart} take effect after a restart.`);
    notes.push("Explorer restarts at the end, so the taskbar flickers once.");
  }
  $("#confirm-title").textContent = `${revert ? "Revert" : "Apply"} ${picked.length} tweaks?`;
  $("#confirm-notes").innerHTML = notes.map((n) => (n.startsWith("<li") ? n : `<li>${n}</li>`)).join("");
  $("#confirm-ok").textContent = revert ? "Revert" : "Apply";
  $("#confirm").hidden = false;
  $("#progress").hidden = true;
  $("#dialog").showModal();
}

async function run() {
  const revert = mode === "revert";
  const picked = selectedTweaks().filter((t) => !revert || t.reversible);
  const restorePoint = $("#restore-point").checked;
  const total = picked.length + (restorePoint ? 1 : 0);
  let finished = 0;

  $("#confirm").hidden = true;
  $("#progress").hidden = false;
  $("#progress-title").textContent = revert ? "Reverting…" : "Applying…";
  $("#progress-close").disabled = true;
  $("#bar-fill").style.width = "0";
  $("#log").innerHTML = "";

  const log = (className, mark, text) => {
    const item = document.createElement("li");
    item.className = className;
    item.innerHTML = `<span class="mark">${mark}</span><span>${escape(text)}</span>`;
    $("#log").append(item);
    item.scrollIntoView({ block: "nearest" });
    return item;
  };
  const nameOf = (id) => (id === "restore-point" ? "Create restore point" : byId(id)?.name ?? id);
  let current = null;

  const unlisten = await listen("log", ({ payload }) => {
    const [kind, ...rest] = payload.split(":");
    const text = rest.join(":");
    if (kind === "run") {
      current = log("", "·", nameOf(text));
    } else if (kind === "done" || kind === "fail") {
      const [id, ...message] = text.split(":");
      finished += 1;
      $("#bar-fill").style.width = `${(finished / total) * 100}%`;
      if (current) current.remove();
      if (kind === "done") log("ok", "✓", nameOf(id));
      else log("fail", "✕", `${nameOf(id)}: ${message.join(":")}`);
      current = null;
    } else if (kind === "log") {
      log("output", "", text);
    }
  });

  try {
    const outcomes = await invoke("run_tweaks", { ids: picked.map((t) => t.id), revert, restorePoint });
    const failed = outcomes.filter((o) => !o.ok && o.id !== "restore-point").length;
    const needsRestart = outcomes.some((o) => o.ok && byId(o.id)?.restart);
    let title = `${revert ? "Reverted" : "Applied"} ${outcomes.filter((o) => o.ok && o.id !== "restore-point").length} tweaks`;
    if (failed) title += `, ${failed} failed`;
    if (needsRestart) title += ". Restart to finish.";
    $("#progress-title").textContent = title;
  } catch (error) {
    $("#progress-title").textContent = "Something went wrong";
    log("fail", "✕", String(error));
  } finally {
    unlisten();
    $("#bar-fill").style.width = "100%";
    $("#progress-close").disabled = false;
    refreshStatus();
  }
}

async function refreshStatus() {
  state.checked = false;
  render();
  try {
    const status = await invoke("get_status");
    state.applied = status.applied;
    $("#system").textContent = status.system;
  } catch (error) {
    $("#system").textContent = `Status check failed: ${error}`;
  }
  state.checked = true;
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
  $("main").scrollTop = 0;
});

$("#list").addEventListener("click", (event) => {
  const row = event.target.closest(".row");
  if (!row || event.target.closest(".details")) return;
  const id = row.dataset.id;
  const set = event.target.closest(".expand") ? state.open : state.selected;
  set.has(id) ? set.delete(id) : set.add(id);
  saveSelection();
  render();
});

$("#list").addEventListener("keydown", (event) => {
  const row = event.target.closest(".row");
  if (!row || event.target !== row || (event.key !== " " && event.key !== "Enter")) return;
  event.preventDefault();
  row.click();
  document.querySelector(`.row[data-id="${row.dataset.id}"]`)?.focus();
});

$("#presets").addEventListener("click", (event) => {
  const name = event.target.dataset.preset;
  if (!name) return;
  const levels = PRESETS[name].levels;
  state.selected = new Set(state.tweaks.filter((t) => levels.includes(t.level)).map((t) => t.id));
  saveSelection();
  render();
});

$("#search").addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

document.addEventListener("keydown", (event) => {
  const typing = document.activeElement === $("#search");
  if ((event.key === "/" && !typing) || (event.key === "k" && event.ctrlKey)) {
    event.preventDefault();
    $("#search").focus();
  } else if (event.key === "Escape" && typing) {
    $("#search").value = "";
    state.query = "";
    $("#search").blur();
    render();
  }
});

$("#clear").addEventListener("click", () => {
  state.selected.clear();
  saveSelection();
  render();
});

$("#apply").addEventListener("click", () => confirmRun(false));
$("#revert").addEventListener("click", () => confirmRun(true));
$("#refresh").addEventListener("click", refreshStatus);
$("#progress-close").addEventListener("click", () => $("#dialog").close());

$("#confirm").addEventListener("submit", (event) => {
  if (event.submitter?.value !== "ok") return;
  event.preventDefault();
  run();
});

// Keep the dialog open while tweaks run.
$("#dialog").addEventListener("cancel", (event) => {
  if (!$("#progress").hidden && $("#progress-close").disabled) event.preventDefault();
});

async function start() {
  state.tweaks = await invoke("list_tweaks");
  const known = new Set(state.tweaks.map((t) => t.id));
  state.selected = new Set([...state.selected].filter((id) => known.has(id)));
  render();
  refreshStatus();
}

start();
