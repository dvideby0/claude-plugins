/**
 * The engine's control panel.
 *
 * Served by the daemon and loaded unchanged by the Electron shell, so there is
 * one UI rather than a desktop one and a web one that drift apart. The shell
 * adds only a folder picker; everything else here is plain HTTP.
 *
 * Projects are the home. Setting up an agent is a one-time job and lives in
 * Settings, except on a first run, where there is nothing to look at yet and
 * the walkthrough takes over.
 */

const { token } = window.__SDLC__;
// The desktop uses a one-time query credential to fetch the token-bearing
// shell. Remove it before any navigation, copy, or history operation can
// retain it; subsequent API requests use the Authorization header below.
if (location.search) history.replaceState(null, "", `${location.pathname}${location.hash}`);
const shell = window.sdlcShell ?? null;

if (shell?.platform === "darwin") document.body.classList.add("mac");

const ui = {
  dot: document.getElementById("health-dot"),
  meta: document.getElementById("engine-meta"),
  nav: document.getElementById("nav"),
  navProjects: document.getElementById("nav-projects"),
  navAgents: document.getElementById("nav-agents"),
  view: document.getElementById("view"),
  toast: document.getElementById("toast"),
};

const state = {
  status: null,
  harnesses: [],
  workspaces: [],
  graph: null,
  /** What the current view was rendered from, so polling does not clobber it. */
  renderedKey: null,
  onboarded: localStorage.getItem("sdlc.onboarded") === "1",
};

// --- plumbing --------------------------------------------------------------

let toastTimer = null;
function toast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    ui.toast.hidden = true;
  }, 3600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(payload?.error ?? `Request failed (${response.status})`);
  return payload;
}

function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

const num = (value) => Number(value ?? 0).toLocaleString();

function relative(iso) {
  if (!iso) return "never";
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** Attach handlers after innerHTML, by data-action. */
/**
 * Wire every [data-action] in a subtree.
 *
 * The scope is explicit because the drawer hangs off <body> rather than the
 * view: defaulting it silently left every button inside the drawer dead,
 * including its own Close.
 */
function on(action, handler, scope = ui.view) {
  for (const element of scope.querySelectorAll(`[data-action="${action}"]`)) {
    element.addEventListener("click", (event) => handler(element, event));
  }
}

// --- routing ---------------------------------------------------------------

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean);

  if (parts[0] === "welcome") return { name: "welcome" };
  if (parts[0] === "settings") return { name: "settings" };
  if (parts[0] === "projects" && parts[1]) {
    return { name: "project", id: parts[1], tab: parts[2] ?? "overview" };
  }
  if (parts[0] === "projects") return { name: "projects" };
  return { name: null };
}

function go(hash) {
  location.hash = hash;
}

/** Where a fresh load should land. */
function defaultRoute() {
  const connected = state.harnesses.some((harness) => harness.connected);
  const setUp = connected || state.workspaces.length > 0 || state.onboarded;
  return setUp ? "#/projects" : "#/welcome";
}

// --- chrome ----------------------------------------------------------------

function renderChrome(route) {
  if (state.status) {
    ui.dot.className = "dot up";
    ui.meta.textContent = `v${state.status.version} · :${state.status.port}`;
  } else {
    ui.dot.className = "dot down";
    ui.meta.textContent = "engine unreachable";
  }

  const onboarding = route.name === "welcome";
  ui.nav.hidden = onboarding;
  document.body.classList.toggle("onboarding", onboarding);
  if (onboarding) return;

  for (const item of ui.nav.querySelectorAll(".nav-item")) {
    const section = item.dataset.section;
    const active =
      (section === "projects" && (route.name === "projects" || route.name === "project")) ||
      (section === "settings" && route.name === "settings");
    item.classList.toggle("active", active);
  }

  const recent = [...state.workspaces]
    .sort((a, b) => (b.lastIndexedAt ?? "").localeCompare(a.lastIndexedAt ?? ""))
    .slice(0, 6);

  ui.navProjects.innerHTML = recent.length
    ? recent
        .map(
          (workspace) => `
          <a class="nav-sub-item ${route.id === workspace.id ? "active" : ""}"
             href="#/projects/${workspace.id}" title="${esc(workspace.root)}">
            ${workspace.indexing ? '<span class="spin"></span>' : '<span class="bullet"></span>'}
            <span class="truncate">${esc(workspace.name)}</span>
          </a>`,
        )
        .join("")
    : `<div class="nav-empty">None yet</div>`;

  const connected = state.harnesses.filter((harness) => harness.connected).length;
  ui.navAgents.innerHTML =
    connected > 0
      ? `<span class="ok">●</span> ${connected} agent${connected === 1 ? "" : "s"} connected`
      : `<span class="warn">●</span> no agent connected`;
}

// --- welcome ---------------------------------------------------------------

function renderWelcome() {
  const connected = state.harnesses.some((harness) => harness.connected);
  const hasProject = state.workspaces.length > 0;

  const agentRows = state.harnesses
    .map((harness) => {
      if (!harness.binPath) {
        return `<div class="agent-row muted">
          <div><strong>${esc(harness.name)}</strong><div class="sub">Not installed on this machine</div></div>
        </div>`;
      }
      return `<div class="agent-row">
        <div>
          <strong>${esc(harness.name)}</strong>
          <div class="sub">${esc(harness.version ?? "")}</div>
        </div>
        <button class="${harness.connected ? "" : "primary"}"
                data-action="toggle-agent" data-id="${harness.id}"
                data-connected="${harness.connected}">
          ${harness.connected ? "Connected ✓" : "Connect"}
        </button>
      </div>`;
    })
    .join("");

  ui.view.innerHTML = `
    <div class="welcome">
      <div class="welcome-inner">
        <div class="welcome-mark">SDLC</div>
        <h1>Let's get you set up</h1>
        <p class="lede">
          The engine is running. It indexes your repositories once and serves every
          agent session from the same warm index.
        </p>

        <section class="wcard ${connected ? "done" : ""}">
          <div class="wcard-head">
            <span class="wstep">${connected ? "✓" : "1"}</span>
            <div>
              <h2>Connect a coding agent</h2>
              <p class="sub">It gets a small bridge that finds this engine on any port.</p>
            </div>
          </div>
          <div class="agents">${agentRows}</div>
        </section>

        <section class="wcard ${hasProject ? "done" : ""}">
          <div class="wcard-head">
            <span class="wstep">${hasProject ? "✓" : "2"}</span>
            <div>
              <h2>Add a repository</h2>
              <p class="sub">
                ${
                  hasProject
                    ? `${num(state.workspaces.length)} added. You can add more any time.`
                    : "Or skip — running an audit from your agent adds one automatically."
                }
              </p>
            </div>
          </div>
          <div class="wcard-body">
            <div class="add-row">
              <input id="welcome-root" type="text" placeholder="/path/to/repository"
                     spellcheck="false" autocomplete="off" />
              <button data-action="browse-welcome" class="ghost" ${shell?.pickDirectory ? "" : "hidden"}>Browse…</button>
              <button data-action="add-welcome" class="primary">Add</button>
            </div>
          </div>
        </section>

        <div class="welcome-foot">
          <button class="${connected || hasProject ? "primary" : "linky"}" data-action="finish">
            ${connected || hasProject ? "Go to Projects" : "Skip for now"}
          </button>
        </div>
      </div>
    </div>
  `;

  on("toggle-agent", (element) => toggleAgent(element.dataset.id, element.dataset.connected === "true"));
  on("browse-welcome", async () => {
    const picked = await shell.pickDirectory();
    if (picked) document.getElementById("welcome-root").value = picked;
  });
  on("add-welcome", async () => {
    const input = document.getElementById("welcome-root");
    if (input.value.trim()) await addWorkspace(input.value.trim(), false);
  });
  on("finish", () => {
    state.onboarded = true;
    localStorage.setItem("sdlc.onboarded", "1");
    go("#/projects");
  });
}

// --- projects --------------------------------------------------------------

function renderProjects() {
  const cards = state.workspaces
    .map((workspace) => {
      const indexed = workspace.indexedFiles > 0;
      const stats = indexed
        ? `<div class="pstats">
             <span><b>${num(workspace.indexedFiles)}</b> files</span>
             <span><b>${num(workspace.symbols)}</b> symbols</span>
             <span><b>${num(workspace.edges)}</b> imports</span>
             <span class="${workspace.openFindings ? "warn" : ""}">
               <b>${num(workspace.openFindings)}</b> findings
             </span>
           </div>`
        : `<div class="pstats muted">Not indexed yet</div>`;

      return `<div class="project" data-action="open-project" data-id="${workspace.id}" role="button" tabindex="0">
        <div class="project-head">
          <h3>${esc(workspace.name)}${workspace.indexing ? '<span class="spin"></span>' : ""}</h3>
          <span class="sub">${indexed ? `indexed ${esc(relative(workspace.lastIndexedAt))}` : ""}</span>
        </div>
        <div class="ppath">${esc(workspace.root)}</div>
        ${stats}
        <div class="project-actions">
          <button data-action="index-project" data-id="${workspace.id}" ${workspace.indexing ? "disabled" : ""}>
            ${workspace.indexing ? "Indexing…" : indexed ? "Re-index" : "Index"}
          </button>
          <button data-action="remove-project" data-id="${workspace.id}" class="danger">Remove</button>
        </div>
      </div>`;
    })
    .join("");

  ui.view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Projects</h1>
          <p class="sub">Repositories this engine indexes. Agents add them automatically on first use.</p>
        </div>
        <div class="page-actions">
          <button class="primary" data-action="add-project">Add repository</button>
        </div>
      </div>

      <div class="add-row" id="add-row" hidden>
        <input id="add-root" type="text" placeholder="/path/to/repository" spellcheck="false" autocomplete="off" />
        <button data-action="add-confirm" class="primary">Add</button>
        <button data-action="add-cancel" class="ghost">Cancel</button>
      </div>

      ${
        state.workspaces.length
          ? `<div class="projects">${cards}</div>`
          : `<div class="empty big">
               <p>No repositories yet.</p>
               <p class="sub">Add one here, or just run an audit from your agent — it registers the repository for you.</p>
               <button class="primary" data-action="add-project">Add repository</button>
             </div>`
      }
    </div>
  `;

  on("open-project", (element) => go(`#/projects/${element.dataset.id}`));
  on("add-project", async () => {
    if (shell?.pickDirectory) {
      const picked = await shell.pickDirectory();
      if (picked) await addWorkspace(picked);
      return;
    }
    const row = document.getElementById("add-row");
    row.hidden = false;
    document.getElementById("add-root").focus();
  });
  on("add-confirm", async () => {
    const value = document.getElementById("add-root").value.trim();
    if (value) await addWorkspace(value);
  });
  on("add-cancel", () => {
    document.getElementById("add-row").hidden = true;
  });
  on("index-project", (element, event) => {
    event.stopPropagation();
    void startIndex(element.dataset.id);
  });
  on("remove-project", (element, event) => {
    event.stopPropagation();
    void removeWorkspace(element.dataset.id);
  });
}

// --- project detail --------------------------------------------------------

const TABS = [
  ["overview", "Overview"],
  ["map", "Map"],
  ["flow", "Flow"],
  ["graph", "Graph"],
  ["findings", "Findings"],
  ["memory", "Memory"],
];

function renderProject(route) {
  const workspace = state.workspaces.find((item) => item.id === route.id);
  if (!workspace) {
    ui.view.innerHTML = `
      <div class="page">
        <div class="empty big">
          <p>That project is no longer registered.</p>
          <button class="primary" data-action="back">Back to Projects</button>
        </div>
      </div>`;
    on("back", () => go("#/projects"));
    return;
  }

  ui.view.innerHTML = `
    <div class="page detail">
      <nav class="crumbs">
        <a href="#/projects">Projects</a><span class="sep">/</span><span>${esc(workspace.name)}</span>
      </nav>

      <div class="page-head">
        <div>
          <h1>${esc(workspace.name)}${workspace.indexing ? '<span class="spin"></span>' : ""}</h1>
          <p class="sub mono">${esc(workspace.root)}</p>
        </div>
        <div class="page-actions">
          ${
            workspace.indexing
              ? `<button data-action="stop" class="danger">Stop</button>`
              : `<button class="primary" data-action="build" title="Scan the code, then have your agent draw the map over it">
                   ${workspace.indexedFiles ? "Rebuild map" : "Build the map"}
                 </button>
                 <button data-action="index">Scan only</button>`
          }
          <button data-action="remove" class="ghost danger">Delete</button>
        </div>
      </div>

      ${workspace.indexing ? progressStrip(workspace) : ""}
      ${
        !workspace.indexing && workspace.jobError
          ? `<div class="notice error">${esc(workspace.jobError)}</div>`
          : ""
      }

      <nav class="tabs">
        ${TABS.map(
          ([key, label]) =>
            `<a href="#/projects/${workspace.id}/${key}" class="${route.tab === key ? "active" : ""}">${label}</a>`,
        ).join("")}
      </nav>

      <div class="pane" id="pane"></div>
    </div>
  `;

  on("index", () => void startIndex(workspace.id));
  on("build", () => void startIndex(workspace.id, true));
  on("stop", () => void stopJob(workspace.id));
  on("remove", () => void removeWorkspace(workspace.id));

  const pane = document.getElementById("pane");
  if (workspace.indexedFiles === 0 && !workspace.indexing) {
    pane.innerHTML = `<div class="empty big">
      <p>Nothing indexed yet.</p>
      <p class="sub">
        <b>Build the map</b> scans the code, then asks your coding agent to read
        it and draw the human version — named components, real flows, notes.
        <b>Scan only</b> stops after the machine index.
      </p>
      <button class="primary" data-action="build-empty">Build the map</button>
    </div>`;
    on("build-empty", () => void startIndex(workspace.id, true));
    return;
  }

  pane.innerHTML = `<div class="loading">Loading…</div>`;
  if (route.tab === "map") void paneMap(workspace, pane);
  else if (route.tab === "flow") void paneFlow(workspace, pane);
  else if (route.tab === "graph") void paneGraph(workspace, pane);
  else if (route.tab === "findings") void paneFindings(workspace, pane);
  else if (route.tab === "memory") void paneMemory(workspace, pane);
  else void paneOverview(workspace, pane);
}

/**
 * What the build is doing right now.
 *
 * The drawing pass runs for minutes and spends real tokens, so silence is the
 * wrong feedback — the tool names the agent is calling are shown as they
 * happen, which is also how you notice it has wandered somewhere useless.
 */
function progressStrip(workspace) {
  const phases = [
    ["scanning", "Scanning code"],
    ["drawing", "Agent drawing the map"],
  ];
  const events = (workspace.events ?? []).slice(-6).reverse();
  return `
    <div class="progress" id="progress">
      <div class="phases">
        ${phases
          .map(([key, label]) => {
            const done =
              workspace.phase === "done" || (key === "scanning" && workspace.phase === "drawing");
            const now = workspace.phase === key;
            return `<span class="phase ${done ? "done" : ""} ${now ? "now" : ""}">
                      ${now ? '<span class="spin"></span>' : done ? "✓ " : ""}${label}
                    </span>`;
          })
          .join('<span class="phase-sep">→</span>')}
      </div>
      ${
        events.length
          ? `<ul class="events">${events.map((event) => `<li>${esc(event.text)}</li>`).join("")}</ul>`
          : ""
      }
    </div>`;
}

function bars(entries, total) {
  return entries
    .map(
      ([label, value]) => `
        <div class="bar-row">
          <span class="label">${esc(label)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${
            total ? Math.max((value / total) * 100, 1.5) : 0
          }%"></span></span>
          <span class="val">${num(value)}</span>
        </div>`,
    )
    .join("");
}

async function paneOverview(workspace, pane) {
  try {
    const [overview, findings] = await Promise.all([
      api(`/api/workspaces/${workspace.id}/overview`),
      api(`/api/workspaces/${workspace.id}/findings`),
    ]);

    const severities = ["critical", "high", "medium", "low"];
    const langTotal = Object.values(overview.languages).reduce((a, b) => a + b, 0);
    const tiles = [
      { k: "files", n: workspace.indexedFiles },
      { k: "symbols", n: workspace.symbols },
      { k: "import edges", n: workspace.edges },
      { k: "unimported", n: overview.orphans },
      ...severities
        .filter((severity) => findings.bySeverity[severity])
        .map((severity) => ({ k: severity, n: findings.bySeverity[severity], cls: `sev-${severity}` })),
    ];

    pane.innerHTML = `
      <div class="tiles">
        ${tiles
          .map(
            (tile) =>
              `<div class="tile ${tile.cls ?? ""}"><div class="n">${num(tile.n)}</div><div class="k">${esc(tile.k)}</div></div>`,
          )
          .join("")}
      </div>

      <div class="block">
        <h3 class="section">Most depended on</h3>
        <table class="rows">
          <tr><th>File</th><th class="num">importers</th><th class="num">loc</th><th class="num">findings</th></tr>
          ${overview.hotspots
            .map(
              (row) => `<tr>
                <td class="path">${esc(row.path)}</td>
                <td class="num">${num(row.importers)}</td>
                <td class="num">${num(row.loc)}</td>
                <td class="num">${row.findings ? `<span class="sev-high">${num(row.findings)}</span>` : "—"}</td>
              </tr>`,
            )
            .join("")}
        </table>
      </div>

      <div class="two-col">
        <div class="block">
          <h3 class="section">Languages</h3>
          ${bars(Object.entries(overview.languages), langTotal)}
        </div>
        ${
          overview.externals.length
            ? `<div class="block">
                 <h3 class="section">Most used dependencies</h3>
                 ${bars(
                   overview.externals.slice(0, 8).map((row) => [row.name, row.used]),
                   overview.externals[0]?.used ?? 1,
                 )}
               </div>`
            : ""
        }
      </div>

      ${
        overview.tools.length
          ? `<div class="block">
              <h3 class="section">Last analysis run</h3>
              <table class="rows">
                <tr><th>Tool</th><th>Status</th><th class="num">findings</th><th>Detail</th></tr>
                ${overview.tools
                  .map(
                    (tool) => `<tr>
                      <td>${esc(tool.tool)}</td>
                      <td class="status-${esc(tool.status)}">${esc(tool.status)}</td>
                      <td class="num">${num(tool.findings)}</td>
                      <td class="sub">${esc(tool.detail ?? "")}</td>
                    </tr>`,
                  )
                  .join("")}
              </table>
            </div>`
          : ""
      }
    `;
  } catch (error) {
    pane.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

async function paneGraph(workspace, pane) {
  pane.innerHTML = `
    <div class="graph-bar">
      <span id="graph-caption" class="sub"></span>
      <div class="graph-controls">
        <label class="ctl">nodes
          <select id="graph-limit">
            <option value="60">60</option>
            <option value="120" selected>120</option>
            <option value="240">240</option>
            <option value="400">400</option>
          </select>
        </label>
        <button id="graph-reset" class="ghost">Reset view</button>
      </div>
    </div>
    <div class="graph-stage">
      <canvas id="graph-canvas"></canvas>
      <div class="graph-legend" id="graph-legend"></div>
      <aside class="inspector" id="inspector" hidden></aside>
    </div>
  `;

  const canvas = document.getElementById("graph-canvas");
  state.graph?.destroy();
  state.graph = window.SDLCGraph.createGraph(canvas, {
    onSelect: (selected) => {
      if (selected) void showFile(workspace, selected.path);
      else document.getElementById("inspector").hidden = true;
    },
  });

  document.getElementById("graph-legend").innerHTML = `
    ${[
      ["typescript", "--info"],
      ["javascript", "--warn"],
      ["python", "--ok"],
    ]
      .map(
        ([label, variable]) =>
          `<span class="legend-item"><span class="swatch" style="background:var(${variable})"></span>${label}</span>`,
      )
      .join("")}
    <span class="legend-item"><span class="swatch ring"></span>has findings</span>
    <span class="legend-item">size = importers</span>
  `;

  async function load() {
    const limit = Number(document.getElementById("graph-limit").value);
    try {
      const graph = await api(`/api/workspaces/${workspace.id}/graph?limit=${limit}`);
      document.getElementById("graph-caption").textContent = graph.truncated
        ? `${num(graph.nodes.length)} most-connected of ${num(graph.totalFiles)} files · ${num(graph.edges.length)} imports between them`
        : `${num(graph.nodes.length)} files · ${num(graph.edges.length)} imports`;
      state.graph.setData(graph);
      document.getElementById("inspector").hidden = true;
    } catch (error) {
      toast(error.message);
    }
  }

  document.getElementById("graph-limit").addEventListener("change", () => void load());
  document.getElementById("graph-reset").addEventListener("click", () => state.graph?.reset());
  await load();
}

/**
 * A side panel any pane can open.
 *
 * The graph tab has its own inspector wired into its layout; everywhere else
 * shares this one, so drilling from a component box into a file works the same
 * way it does from a node.
 */
function openDrawer() {
  let drawer = document.getElementById("drawer");
  if (!drawer) {
    drawer = document.createElement("aside");
    drawer.id = "drawer";
    drawer.className = "inspector drawer";
    document.body.append(drawer);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeDrawer();
    });
  }
  drawer.hidden = false;
  return drawer;
}

function closeDrawer() {
  const drawer = document.getElementById("drawer");
  if (drawer) drawer.hidden = true;
}

async function showFile(workspace, path) {
  const inspector = document.getElementById("inspector") ?? openDrawer();
  try {
    const file = await api(`/api/workspaces/${workspace.id}/file?path=${encodeURIComponent(path)}`);
    const list = (title, values) =>
      values.length
        ? `<div class="insp-section">
             <h3 class="section">${esc(title)} (${values.length})</h3>
             <div class="insp-list">${values
               .map((value) => `<button data-path="${esc(value)}">${esc(value)}</button>`)
               .join("")}</div>
           </div>`
        : "";

    inspector.innerHTML = `
      <button class="close" aria-label="Close">×</button>
      <h4>${esc(file.path)}</h4>
      <div class="sub">${esc(file.lang)} · ${num(file.loc)} loc · churn ${num(file.churn)}${file.isTest ? " · test" : ""}</div>
      ${
        file.component
          ? `<div class="insp-component">
               In <button class="linky" data-component="${esc(file.component.id)}">${esc(file.component.name)}</button>
             </div>`
          : `<div class="insp-component sub">Not in any drawn component yet.</div>`
      }
      ${
        file.findings.length
          ? `<div class="insp-section">
               <h3 class="section">Findings</h3>
               ${file.findings
                 .map(
                   (finding) => `<div class="insp-finding">
                     <span class="sevtag sev-${esc(finding.severity)}">${esc(finding.severity)}</span>
                     <div>${esc(finding.title)}</div>
                   </div>`,
                 )
                 .join("")}
             </div>`
          : ""
      }
      ${list("Imported by", file.importers)}
      ${list("Imports", file.imports)}
      ${list("External packages", file.externals)}
      ${
        file.symbols.length
          ? `<div class="insp-section">
               <h3 class="section">Symbols (${file.symbols.length})</h3>
               <div class="insp-list">${file.symbols
                 .slice(0, 40)
                 .map((symbol) => `<span class="mono dim">${esc(symbol.kind)} ${esc(symbol.name)}</span>`)
                 .join("")}</div>
             </div>`
          : ""
      }
    `;
    inspector.hidden = false;
    inspector.querySelector(".close").addEventListener("click", () => {
      inspector.hidden = true;
    });
    for (const link of inspector.querySelectorAll("[data-component]")) {
      link.addEventListener("click", () => void showComponent(workspace, link.dataset.component));
    }
    for (const button of inspector.querySelectorAll("[data-path]")) {
      button.addEventListener("click", () => {
        state.graph?.select(button.dataset.path);
        void showFile(workspace, button.dataset.path);
      });
    }
  } catch (error) {
    toast(error.message);
  }
}

/** Which lifecycle slice the findings tab is showing. */
let findingStatus = "open";

async function paneFindings(workspace, pane) {
  try {
    const findings = await api(
      `/api/workspaces/${workspace.id}/findings?status=${encodeURIComponent(findingStatus)}`,
    );

    const filters = [
      ["open", "Open"],
      ["fixed", "Fixed"],
      ["regressed", "Regressed"],
      ["accepted", "Accepted"],
      ["false_positive", "False positive"],
      ["all", "All"],
    ]
      .map(([key, label]) => {
        const count = key === "all" ? null : (findings.byStatus[key] ?? 0);
        const shown = key === "open" ? (findings.byStatus.open ?? 0) + (findings.byStatus.regressed ?? 0) : count;
        return `<button class="chip ${findingStatus === key ? "on" : ""}" data-action="filter" data-status="${key}">
                  ${label}${shown === null ? "" : ` <span class="chip-n">${num(shown)}</span>`}
                </button>`;
      })
      .join("");

    const body =
      findings.rows.length === 0
        ? `<div class="empty big">
             <p>Nothing here.</p>
             <p class="sub">${
               findingStatus === "open"
                 ? 'Run <code class="inline">/audit</code> from your agent for a model review pass.'
                 : "No findings in this state yet."
             }</p>
           </div>`
        : `<table class="rows findings">
             <tr><th>Severity</th><th>Finding</th><th>File</th><th>Rule</th><th></th></tr>
             ${findings.rows
               .map(
                 (row, index) => `
                 <tr class="frow" data-action="expand" data-index="${index}">
                   <td><span class="sevtag sev-${esc(row.severity)}">${esc(row.severity)}</span></td>
                   <td>${esc(row.title)}${
                     row.status !== "open"
                       ? ` <span class="pill">${esc(row.status.replace("_", " "))}</span>`
                       : ""
                   }</td>
                   <td class="path">${esc(row.path ?? "—")}${row.lineStart ? `:${row.lineStart}` : ""}</td>
                   <td class="sub">${esc(row.ruleId)}</td>
                   <td class="sub chev">›</td>
                 </tr>
                 <tr class="fdetail" id="fd-${index}" hidden><td colspan="5"></td></tr>`,
               )
               .join("")}
           </table>`;

    pane.innerHTML = `
      <div class="chips">${filters}</div>
      <div class="tiles">
        ${["critical", "high", "medium", "low"]
          .filter((severity) => findings.bySeverity[severity])
          .map(
            (severity) =>
              `<div class="tile sev-${severity}"><div class="n">${num(findings.bySeverity[severity])}</div><div class="k">${severity} open</div></div>`,
          )
          .join("")}
      </div>
      ${body}
      ${
        findings.rows.length < findings.total
          ? `<div class="sub" style="margin-top:10px">Showing ${num(findings.rows.length)} of ${num(findings.total)}.</div>`
          : ""
      }
    `;

    on("filter", (element) => {
      findingStatus = element.dataset.status;
      void paneFindings(workspace, pane);
    });

    on("expand", (element) => {
      const index = Number(element.dataset.index);
      const row = findings.rows[index];
      const holder = document.getElementById(`fd-${index}`);
      if (!holder) return;
      if (!holder.hidden) {
        holder.hidden = true;
        return;
      }

      const canTriage = row.status === "open" || row.status === "regressed";
      holder.querySelector("td").innerHTML = `
        <div class="fdetail-body">
          ${row.description ? `<p>${esc(row.description)}</p>` : ""}
          ${row.suggestion ? `<p><strong>Suggested:</strong> ${esc(row.suggestion)}</p>` : ""}
          <div class="sub">
            ${esc(row.category)} · confidence ${esc(row.confidence)} · found by ${esc(row.source)}
            ${row.occurrences > 1 ? ` · seen ${num(row.occurrences)}×` : ""}
          </div>
          ${
            canTriage
              ? `<div class="triage">
                   <input type="text" placeholder="Reason (required)" data-reason="${index}" />
                   <button data-action="accept" data-id="${esc(row.id)}" data-index="${index}">Accept risk</button>
                   <button data-action="falsep" data-id="${esc(row.id)}" data-index="${index}">False positive</button>
                 </div>`
              : ""
          }
        </div>`;
      holder.hidden = false;

      const suppressWith = async (button, disposition) => {
        const reason = document.querySelector(`[data-reason="${button.dataset.index}"]`)?.value.trim();
        if (!reason) {
          toast("Give a reason — it is kept with the suppression.");
          return;
        }
        try {
          await api(`/api/workspaces/${workspace.id}/findings/${button.dataset.id}/suppress`, {
            method: "POST",
            body: JSON.stringify({ reason, disposition }),
          });
          toast(
            disposition === "accepted"
              ? "Risk accepted. The decision will persist across future runs."
              : "Marked false positive. It will not come back on future runs.",
          );
          void paneFindings(workspace, pane);
        } catch (error) {
          toast(error.message);
        }
      };
      on("accept", (button) => void suppressWith(button, "accepted"));
      on("falsep", (button) => void suppressWith(button, "false_positive"));
    });
  } catch (error) {
    pane.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

// --- map -------------------------------------------------------------------

/**
 * The drawn map: nested boxes and the flows through them.
 *
 * Deliberately a document rather than a node-link graph. This is the view that
 * answers "what is this system", and boxes-inside-boxes with prose reads far
 * better for that than anything with edges in it — the graph tabs are already
 * there for the other question.
 */
async function paneMap(workspace, pane) {
  pane.innerHTML = `<div class="loading">Loading…</div>`;
  let map;
  try {
    map = await api(`/api/workspaces/${workspace.id}/map`);
  } catch (error) {
    pane.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    return;
  }

  if (map.empty) {
    pane.innerHTML = `<div class="empty big">
      <p>Nothing drawn yet.</p>
      <p class="sub">
        The index knows the files; nobody has said what they <em>are</em>.
        Run <code class="inline">/map</code> from your agent to draw the
        components and flows, then come back.
      </p>
    </div>`;
    return;
  }

  const roots = map.components.filter((component) => !component.parent);
  const byId = new Map(map.components.map((component) => [component.id, component]));

  const box = (component, depth) => {
    const children = component.children.map((id) => byId.get(id)).filter(Boolean);
    return `
      <div class="mapbox depth-${Math.min(depth, 2)} ${component.drifted ? "drifted" : ""}"
           data-action="open-component" data-id="${component.id}" role="button" tabindex="0"
           title="Open the files behind this box">
        <div class="mapbox-head">
          <span class="mapbox-name">${esc(component.name)}</span>
          <span class="mapbox-kind">${esc(component.kind)}</span>
          ${component.drifted ? '<span class="pill warnpill" title="Files here changed after this was drawn">moved</span>' : ""}
        </div>
        ${component.summary ? `<p class="mapbox-summary">${esc(component.summary)}</p>` : ""}
        <div class="mapbox-stats">
          <span>${num(component.rollupFiles ?? component.fileCount)} files</span>
          <span>${num(component.rollupSymbols ?? component.symbolCount)} symbols</span>
          ${component.openFindings ? `<span class="warn">${num(component.openFindings)} findings</span>` : ""}
          ${component.tags.map((tag) => `<span class="tagchip">${esc(tag)}</span>`).join("")}
        </div>
        ${children.length ? `<div class="mapbox-children">${children.map((child) => box(child, depth + 1)).join("")}</div>` : ""}
      </div>`;
  };

  const flows = map.flows
    .map(
      (flow) => `
      <div class="mapflow">
        <div class="mapflow-head">
          <strong>${esc(flow.name)}</strong>
          ${flow.trigger ? `<span class="sub">triggered by ${esc(flow.trigger)}</span>` : ""}
        </div>
        ${flow.summary ? `<p class="sub mapflow-summary">${esc(flow.summary)}</p>` : ""}
        <ol class="mapflow-steps">
          ${flow.steps
            .map(
              (step) => `
            <li class="${step.resolves ? "" : "gone"} ${step.drifted ? "moved" : ""}
                       ${step.path ? "clickable" : ""}"
                ${step.path ? `data-action="open-step" data-path="${esc(step.path)}"` : ""}>
              <div class="step-label">${esc(step.label)}</div>
              <div class="step-where">
                ${step.component ? `<span class="tagchip">${esc(step.component)}</span>` : ""}
                ${step.symbol ? `<span class="mono">${esc(step.symbol)}</span>` : ""}
                ${step.resolves ? "" : '<span class="warn">file no longer exists</span>'}
                ${step.drifted ? '<span class="warn">code changed since</span>' : ""}
              </div>
              ${step.note ? `<div class="step-note">${esc(step.note)}</div>` : ""}
            </li>`,
            )
            .join("")}
        </ol>
      </div>`,
    )
    .join("");

  const coverage = map.coverage;
  pane.innerHTML = `
    <p class="sub maplead">
      Drawn by an agent that read the code. Every box opens onto the files
      underneath it — the prose says how it works, the index says what would
      change if you edited it.
    </p>
    <div class="mapcoverage">
      <div class="bar-row">
        <span class="label">explained</span>
        <span class="bar-track"><span class="bar-fill" style="width:${coverage.percent}%"></span></span>
        <span class="val">${coverage.percent}%</span>
      </div>
      <div class="sub">
        ${num(coverage.assigned)} of ${num(coverage.total)} files sit in a component.
        ${coverage.unassigned.length ? `Unexplained: ${coverage.unassigned.slice(0, 6).map(esc).join(", ")}${coverage.unassigned.length > 6 ? ` and ${coverage.unassigned.length - 6} more` : ""}.` : ""}
      </div>
    </div>

    <div class="block">
      <h3 class="section">Components</h3>
      <div class="mapboxes">${roots.map((component) => box(component, 0)).join("")}</div>
    </div>

    ${flows ? `<div class="block"><h3 class="section">Flows</h3>${flows}</div>` : ""}

    ${
      map.tags.length
        ? `<div class="block"><h3 class="section">Tags</h3>
             <div class="mapbox-stats">${map.tags.map((tag) => `<span class="tagchip" title="${esc(tag.description)}">${esc(tag.name)} · ${tag.count}</span>`).join("")}</div>
           </div>`
        : ""
    }
  `;

  // Boxes nest, so a click on a child also reaches its parent's handler and
  // the outer box wins. Stop it at the box that was actually clicked.
  on("open-component", (element, event) => {
    event.stopPropagation();
    void showComponent(workspace, element.dataset.id);
  });
  on("open-step", (element, event) => {
    event.stopPropagation();
    void showFile(workspace, element.dataset.path);
  });
}

/**
 * The box, opened.
 *
 * This is the crossing point between the two maps: the drawn summary at the
 * top, the machine's file list under it, and every row a way further down into
 * imports, symbols and findings.
 */
async function showComponent(workspace, id) {
  const drawer = openDrawer();
  drawer.innerHTML = `<div class="loading">Loading…</div>`;
  let detail;
  try {
    detail = await api(`/api/workspaces/${workspace.id}/component?id=${encodeURIComponent(id)}`);
  } catch (error) {
    drawer.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    return;
  }

  drawer.innerHTML = `
    <div class="drawer-head">
      <div>
        <h2>${esc(detail.name)}</h2>
        <span class="mapbox-kind">${esc(detail.kind)}</span>
      </div>
      <button class="ghost" data-action="close-drawer">Close</button>
    </div>

    <p class="drawer-summary">${esc(detail.summary)}</p>
    ${
      detail.patterns.length
        ? `<div class="mapbox-stats">covers ${detail.patterns.map((pattern) => `<code class="inline">${esc(pattern)}</code>`).join(" ")}</div>`
        : ""
    }

    ${
      detail.flows.length
        ? `<div class="block">
             <h3 class="section">Flows through here</h3>
             ${detail.flows
               .map(
                 (flow) =>
                   `<div class="sub"><b>${esc(flow.name)}</b> — ${flow.steps.map(esc).join(" → ")}</div>`,
               )
               .join("")}
           </div>`
        : ""
    }

    ${
      detail.memories.length
        ? `<div class="block">
             <h3 class="section">Recorded about this</h3>
             ${detail.memories
               .map(
                 (memory) =>
                   `<div class="sub"><span class="tagchip">${esc(memory.kind)}</span> ${esc(memory.title)}</div>`,
               )
               .join("")}
           </div>`
        : ""
    }

    ${
      detail.children.length
        ? `<div class="block">
             <h3 class="section">Contains</h3>
             <div class="childboxes">
               ${detail.children
                 .map(
                   (child) => `
                 <button class="childbox" data-action="open-child" data-id="${esc(child.id)}">
                   <b>${esc(child.name)}</b>
                   <span class="mapbox-kind">${esc(child.kind)}</span>
                   <span class="sub">${esc(child.summary)}</span>
                   <span class="sub">${num(child.fileCount)} files</span>
                 </button>`,
                 )
                 .join("")}
             </div>
           </div>`
        : ""
    }

    ${
      detail.files.length
        ? `<div class="block">
      <h3 class="section">What is actually in here — ${detail.files.length} files</h3>
      <table class="rows">
        <thead><tr><th>File</th><th>Lines</th><th>Symbols</th><th>Used by</th><th></th></tr></thead>
        <tbody>
          ${detail.files
            .map(
              (file) => `
            <tr data-action="open-file" data-path="${esc(file.path)}" class="clickable">
              <td class="mono">${esc(file.path)}${file.changed ? ' <span class="warn">changed</span>' : ""}</td>
              <td class="numeric">${num(file.loc)}</td>
              <td class="numeric">${num(file.symbols)}</td>
              <td class="numeric">${num(file.fanIn)}</td>
              <td>${file.openFindings ? `<span class="warn">${file.openFindings}</span>` : ""}
                  ${file.tags.map((tag) => `<span class="tagchip">${esc(tag)}</span>`).join("")}</td>
            </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>`
        : detail.children.length
          ? `<p class="sub">This box groups the ones above rather than holding files itself.</p>`
          : `<p class="sub">No files match this box's patterns.</p>`
    }
  `;

  on("close-drawer", closeDrawer, drawer);
  on("open-child", (element) => void showComponent(workspace, element.dataset.id), drawer);
  on("open-file", (element) => void showFile(workspace, element.dataset.path), drawer);
}

// --- flow ------------------------------------------------------------------

/** Which entry point the flow is rooted at. */
let flowRoot = null;

async function paneFlow(workspace, pane) {
  pane.innerHTML = `
    <div class="graph-bar">
      <span id="flow-caption" class="sub"></span>
      <div class="graph-controls">
        <label class="ctl">depth
          <select id="flow-depth">
            <option value="2">2</option>
            <option value="3" selected>3</option>
            <option value="4">4</option>
            <option value="6">6</option>
          </select>
        </label>
      </div>
    </div>
    <div class="flow-split">
      <aside class="flow-rail" id="flow-rail"></aside>
      <div class="flow-stage" id="flow-stage"></div>
    </div>
    <aside class="inspector" id="flow-inspector" hidden></aside>
  `;

  const rail = document.getElementById("flow-rail");
  const stage = document.getElementById("flow-stage");
  const caption = document.getElementById("flow-caption");

  // Depth 0 expands nothing, so this is just the list of ways into the code.
  let entryView;
  try {
    entryView = await api(`/api/workspaces/${workspace.id}/flow?depth=0`);
  } catch (error) {
    stage.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    return;
  }

  const entryNodes = entryView.nodes.filter((node) => entryView.entries.includes(node.id));
  if (entryNodes.length === 0) {
    pane.innerHTML = `<div class="empty big">
      <p>No entry points found.</p>
      <p class="sub">Entry points come from the call graph — callable symbols nothing else calls.
      Re-index to build it.</p>
    </div>`;
    return;
  }

  if (!flowRoot || !entryNodes.some((node) => node.id === flowRoot.id)) {
    flowRoot = { id: entryNodes[0].id, symbol: entryNodes[0].symbol, path: entryNodes[0].path };
  }

  function renderRail() {
    rail.innerHTML = `
      <div class="rail-head">Entry points</div>
      ${entryNodes
        .map(
          (node) => `
          <button class="rail-item ${node.id === flowRoot.id ? "active" : ""}"
                  data-id="${esc(node.id)}" data-symbol="${esc(node.symbol)}" data-path="${esc(node.path)}">
            <span class="rail-name">${esc(node.symbol)}</span>
            <span class="rail-sub">${esc(node.path.split("/").slice(-2).join("/"))}</span>
            <span class="rail-count">${node.callees}</span>
          </button>`,
        )
        .join("")}
    `;
    for (const button of rail.querySelectorAll(".rail-item")) {
      button.addEventListener("click", () => {
        flowRoot = { id: button.dataset.id, symbol: button.dataset.symbol, path: button.dataset.path };
        renderRail();
        void loadFlow();
      });
    }
  }

  async function loadFlow() {
    const depth = document.getElementById("flow-depth").value;
    const params = new URLSearchParams({
      depth,
      rootId: flowRoot.id,
    });
    stage.innerHTML = `<div class="loading">Tracing…</div>`;
    document.getElementById("flow-inspector").hidden = true;

    try {
      const view = await api(`/api/workspaces/${workspace.id}/flow?${params}`);
      caption.innerHTML =
        `<strong>${esc(flowRoot.symbol)}</strong> → ${view.nodes.length - 1} reachable` +
        (view.commons.length ? ` · ${view.commons.length} shared` : "") +
        (view.truncated ? " · truncated" : "");

      window.SDLCFlow.render(stage, view, {
        onSelect: (hit) => void showFlowNode(workspace, hit),
        // Double-click walks deeper: the clicked symbol becomes the new root.
        onExpand: (hit) => {
          flowRoot = { id: hit.id, symbol: hit.symbol, path: hit.path };
          renderRail();
          void loadFlow();
        },
      });
    } catch (error) {
      stage.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    }
  }

  document.getElementById("flow-depth").addEventListener("change", () => void loadFlow());
  renderRail();
  await loadFlow();
}

async function showFlowNode(workspace, hit) {
  const inspector = document.getElementById("flow-inspector");
  if (!inspector) return;
  try {
    const file = await api(
      `/api/workspaces/${workspace.id}/file?path=${encodeURIComponent(hit.path)}`,
    );
    const node = hit.node ?? {};
    inspector.innerHTML = `
      <button class="close" aria-label="Close">×</button>
      <h4>${esc(hit.symbol)}</h4>
      <div class="sub">${esc(hit.path)}${node.line ? `:${node.line}` : ""}</div>
      <div class="insp-section">
        <h3 class="section">In the flow</h3>
        <div class="sub">
          ${num(node.callers ?? 0)} caller(s) · ${num(node.callees ?? 0)} callee(s) · depth ${node.depth ?? 0}
          ${node.commons ? "<br>Shared utility — called from many places." : ""}
        </div>
      </div>
      ${
        file.findings.length
          ? `<div class="insp-section">
               <h3 class="section">Findings in this file</h3>
               ${file.findings
                 .map(
                   (finding) =>
                     `<div class="insp-finding"><span class="sevtag sev-${esc(finding.severity)}">${esc(finding.severity)}</span><div>${esc(finding.title)}</div></div>`,
                 )
                 .join("")}
             </div>`
          : ""
      }
      <div class="insp-section sub">Double-click a node to follow the flow from there.</div>
    `;
    inspector.hidden = false;
    inspector.querySelector(".close").addEventListener("click", () => {
      inspector.hidden = true;
    });
  } catch (error) {
    toast(error.message);
  }
}

// --- memory ----------------------------------------------------------------

async function paneMemory(workspace, pane) {
  try {
    const view = await api(`/api/workspaces/${workspace.id}/memories`);
    if (view.total === 0) {
      pane.innerHTML = `<div class="empty big">
        <p>Nothing recorded yet.</p>
        <p class="sub">
          Agents write here with <code class="inline">remember</code> — decisions, conventions,
          constraints and traps that reading the code will not tell you. Try
          <code class="inline">/understand</code> on something gnarly.
        </p>
      </div>`;
      return;
    }

    pane.innerHTML = `
      <div class="tiles">
        ${Object.entries(view.byKind)
          .map(
            ([kind, count]) =>
              `<div class="tile"><div class="n">${num(count)}</div><div class="k">${esc(kind)}</div></div>`,
          )
          .join("")}
      </div>
      <div class="memories">
        ${view.memories
          .map(
            (memory) => `
            <div class="memory">
              <div class="memory-head">
                <span class="pill kind-${esc(memory.kind)}">${esc(memory.kind)}</span>
                <strong>${esc(memory.title)}</strong>
              </div>
              ${memory.body ? `<p class="memory-body">${esc(memory.body)}</p>` : ""}
              <div class="memory-foot">
                ${
                  memory.anchors.length
                    ? memory.anchors
                        .map(
                          (anchor) =>
                            `<span class="anchor ${anchor.stale ? "stale" : ""}"
                                   title="${anchor.stale ? "The file changed after this was written" : ""}">
                               ${esc(anchor.path)}${anchor.symbol ? `#${esc(anchor.symbol)}` : ""}${anchor.stale ? " ⚠" : ""}
                             </span>`,
                        )
                        .join("")
                    : '<span class="sub">not anchored to a file</span>'
                }
                <span class="sub">${esc(relative(memory.updatedAt))}</span>
              </div>
            </div>`,
          )
          .join("")}
      </div>
    `;
  } catch (error) {
    pane.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

// --- settings --------------------------------------------------------------

function renderSettings() {
  const agents = state.harnesses
    .map((harness) => {
      const installed = Boolean(harness.binPath);
      return `<div class="setting">
        <div class="setting-body">
          <div class="setting-title">
            ${esc(harness.name)}
            ${harness.connected ? '<span class="pill on">connected</span>' : ""}
          </div>
          <div class="sub">
            ${
              installed
                ? `${esc(harness.version ?? "installed")} · <span class="mono">${esc(harness.configPath)}</span>`
                : "Not installed on this machine"
            }
          </div>
          ${
            harness.connected
              ? `<div class="sub note">Restart ${esc(harness.name)} to pick up changes — it reads MCP servers at startup.</div>`
              : ""
          }
        </div>
        <button class="${harness.connected ? "danger" : "primary"}"
                data-action="toggle-agent" data-id="${harness.id}"
                data-connected="${harness.connected}" ${installed ? "" : "disabled"}>
          ${harness.connected ? "Disconnect" : "Connect"}
        </button>
      </div>`;
    })
    .join("");

  const status = state.status;
  ui.view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Settings</h1>
          <p class="sub">Coding agents and the local engine.</p>
        </div>
      </div>

      <div class="block">
        <h3 class="section">Coding agents</h3>
        <p class="sub block-lede">
          A connected agent spawns a small bridge that finds this engine on whatever
          port it is using, so restarting the engine never leaves stale config behind.
        </p>
        <div class="settings-list">${agents}</div>
      </div>

      <div class="block">
        <h3 class="section">Engine</h3>
        <table class="rows kv">
          <tr><td>Version</td><td class="mono">${esc(status?.version ?? "—")}</td></tr>
          <tr><td>Address</td><td class="mono">127.0.0.1:${esc(status?.port ?? "—")}</td></tr>
          <tr><td>Process</td><td class="mono">pid ${esc(status?.pid ?? "—")}</td></tr>
          <tr><td>Started</td><td>${esc(relative(status?.startedAt))}</td></tr>
          <tr><td>Projects</td><td>${num(status?.workspaces ?? 0)}</td></tr>
          <tr><td>State</td><td class="mono">~/.sdlc</td></tr>
          <tr><td>Log</td><td class="mono">~/.sdlc/daemon.log</td></tr>
        </table>
      </div>

      <div class="block">
        <h3 class="section">Setup</h3>
        <button data-action="rerun-setup">Run the setup walkthrough again</button>
      </div>
    </div>
  `;

  on("toggle-agent", (element) => toggleAgent(element.dataset.id, element.dataset.connected === "true"));
  on("rerun-setup", () => go("#/welcome"));
}

// --- actions ---------------------------------------------------------------

async function toggleAgent(id, connected) {
  const harness = state.harnesses.find((item) => item.id === id);
  try {
    const result = await api(`/api/harnesses/${id}/${connected ? "disconnect" : "connect"}`, {
      method: "POST",
    });
    state.harnesses = result.harnesses;
    state.renderedKey = null;
    render();
    toast(
      connected
        ? `${harness?.name ?? id} disconnected.`
        : `${harness?.name ?? id} connected — restart it to pick up the change.`,
    );
  } catch (error) {
    toast(error.message);
  }
}

async function addWorkspace(root, navigate = true) {
  try {
    const created = await api("/api/workspaces", {
      method: "POST",
      body: JSON.stringify({ root }),
    });
    await refresh(true);
    toast(`Added ${created.name}.`);
    if (navigate) go(`#/projects/${created.id}`);
  } catch (error) {
    toast(error.message);
  }
}

async function startIndex(id, draw = false) {
  try {
    const harness = draw ? (state.harnesses ?? []).find((item) => item.connected) : null;
    if (draw && !harness) {
      toast("Connect a coding agent in Settings first — the drawing pass runs through it.");
      go("#/settings");
      return;
    }
    await api(`/api/workspaces/${id}/index`, {
      method: "POST",
      body: JSON.stringify({ draw: harness ? harness.id : null }),
    });
    toast(draw ? `Scanning, then ${harness.name} will draw the map.` : "Scanning.");
    await refresh(true);
  } catch (error) {
    toast(error.message);
  }
}

async function stopJob(id) {
  try {
    await api(`/api/workspaces/${id}/stop`, { method: "POST" });
    await refresh(true);
  } catch (error) {
    toast(error.message);
  }
}

async function removeWorkspace(id) {
  try {
    await api(`/api/workspaces/${id}`, { method: "DELETE" });
    toast("Removed. The store on disk was left alone.");
    if (parseHash().id === id) go("#/projects");
    await refresh(true);
  } catch (error) {
    toast(error.message);
  }
}

// --- render loop -----------------------------------------------------------

function viewKey(route) {
  // Re-render only when something the current view depends on has moved.
  const workspaces = state.workspaces
    .map((w) => `${w.id}:${w.indexing ? 1 : 0}:${w.indexedFiles}:${w.openFindings}`)
    .join(",");
  const agents = state.harnesses.map((h) => `${h.id}:${h.connected ? 1 : 0}`).join(",");
  return JSON.stringify([route, workspaces, agents, Boolean(state.status)]);
}

function render() {
  let route = parseHash();
  if (route.name === null) {
    go(defaultRoute());
    return;
  }

  const key = viewKey(route);
  renderChrome(route);
  if (key === state.renderedKey) return;
  state.renderedKey = key;

  if (route.name !== "project" || parseHash().tab !== "graph") {
    state.graph?.destroy();
    state.graph = null;
  }

  if (route.name === "welcome") renderWelcome();
  else if (route.name === "projects") renderProjects();
  else if (route.name === "project") renderProject(route);
  else if (route.name === "settings") renderSettings();
}

/**
 * Refresh the progress strip in place.
 *
 * A running build emits an event every few seconds. Putting those in viewKey
 * would re-render the whole project view each time and throw away whatever
 * pane the user is reading, so the strip is patched on its own.
 */
function patchProgress() {
  const strip = document.getElementById("progress");
  if (!strip) return;
  const route = parseHash();
  const workspace = state.workspaces.find((item) => item.id === route.id);
  if (!workspace?.indexing) return;
  const next = progressStrip(workspace);
  const holder = document.createElement("div");
  holder.innerHTML = next;
  const replacement = holder.firstElementChild;
  if (replacement && replacement.innerHTML !== strip.innerHTML) {
    strip.innerHTML = replacement.innerHTML;
  }
}

let inFlight = false;
async function refresh(force = false) {
  if (inFlight) return;
  inFlight = true;
  try {
    const [status, harnesses, workspaces] = await Promise.all([
      api("/api/status"),
      api("/api/harnesses"),
      api("/api/workspaces"),
    ]);
    state.status = status;
    state.harnesses = harnesses;
    state.workspaces = workspaces;
    if (force) state.renderedKey = null;
    render();
    patchProgress();
  } catch {
    state.status = null;
    render();
  } finally {
    inFlight = false;
  }
}

window.addEventListener("hashchange", () => {
  state.renderedKey = null;
  render();
});

void refresh(true);
setInterval(() => void refresh(), 2500);
