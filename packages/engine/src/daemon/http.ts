/**
 * The daemon's HTTP surface: MCP for agents, a control API for the desktop
 * app, and the UI itself.
 *
 * MCP sessions remain lightweight, but they are stateful for one important
 * reason: cancellation is a second HTTP request that must reach the same MCP
 * server and abort controller as the tool call it names.
 */

import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { drawMap, supportedHarnesses, type DrawEvent, type DrawPhase } from "./draw.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { EngineStatus, WorkspaceStatus } from "@sdlc/protocol";
import { closeDb, getDb } from "../db/db.js";
import { loadPlan } from "../plan/risk.js";
import { scan } from "../scan/scan.js";
import { createMcpServer, ENGINE_VERSION } from "../mcp/server.js";
import { checkOrigin, checkToken, checkUiBootstrap } from "./auth.js";
import { connectHarness, detectHarnesses, disconnectHarness, type BridgeCommand } from "./harnesses.js";
import { suppress } from "../findings/record.js";
import { buildReports } from "../report/export.js";
import { findingsView, fileView, graphView, memoriesView, overviewView } from "./views.js";
import { CROSS_KINDS, crossQuery, type CrossKind } from "../graph/cross.js";
import { flowView } from "../graph/flow.js";
import { componentDetail, systemMap } from "../graph/map.js";
import { resolveTypesInWorker } from "../graph/typed.js";
import { terminateProcessTree } from "../lib/exec.js";
import { WorkspaceWatcher } from "./watcher.js";
import { hasTypedConfigChange, WatchRefreshQueue } from "./watch-refresh.js";
import { WorkspaceRegistry } from "./workspaces.js";

export interface HttpServerOptions {
  token: string;
  registry: WorkspaceRegistry;
  /** How a harness should spawn the bridge, recorded into harness config. */
  bridge: BridgeCommand;
  log: (message: string) => void;
  /** Ask the owning daemon process to perform its full graceful shutdown. */
  onShutdownRequested?: () => void;
}

/** A workspace must be a directory, not merely an existing filesystem path. */
export function isWorkspaceDirectory(root: string): boolean {
  try {
    return statSync(root).isDirectory();
  } catch {
    return false;
  }
}

/** Parse an HTTP request target without letting malformed local traffic escape. */
export function requestPath(target: string | undefined): string | null {
  try {
    return new URL(target ?? "/", "http://127.0.0.1").pathname;
  } catch {
    return null;
  }
}

/** Indexing runs in the background; the UI polls for the result. */
/**
 * One build of a workspace: the deterministic scan, then optionally the agent
 * pass that draws the human map over it.
 *
 * Both phases share a job because to the person who pressed the button they
 * are one action — "make sense of this repository" — and splitting them in the
 * UI would mean explaining an implementation detail they did not ask about.
 */
interface IndexJob {
  running: boolean;
  startedAt: string;
  error: string | null;
  phase: DrawPhase;
  /** Recent activity, newest last. Bounded — this is a progress readout. */
  events: DrawEvent[];
  /** Set while an agent is running, so it can be stopped. */
  child: ChildProcess | null;
  /**
   * Set by the stop endpoint. The scan phase has no child to kill, so
   * without this a stop pressed during "Scanning" still spawned the agent —
   * and spent the user's tokens — a minute after they said no.
   */
  stopped: boolean;
  /** Settles after every scan, typed pass and draw has released the store. */
  finished: Promise<void>;
}

interface ActiveMcpSession {
  transport: StreamableHTTPServerTransport;
  close: () => void;
  /** Canonical and caller-supplied roots touched through this session. */
  roots: Set<string>;
  /** Requests that may still hold a workspace database handle. */
  requests: Set<Promise<void>>;
  /** Fire-and-forget registry writes started when a read-only tool first touches a root. */
  registrations: Set<Promise<void>>;
  closed: boolean;
}

const MAX_EVENTS = 40;
const STOP_GRACE_MS = 5_000;

type StoppableIndexJob = Pick<IndexJob, "running" | "phase" | "error" | "child" | "stopped">;

/** Stop a draw without making it look exited until the child really closes. */
export function requestIndexStop(job: StoppableIndexJob, graceMs = STOP_GRACE_MS): void {
  const child = job.child;
  const force = job.stopped;
  job.stopped = true;
  job.phase = "failed";
  job.error = "Stopped.";

  if (!child) return;
  terminateProcessTree(child, force);
  if (force) return;

  const escalation = setTimeout(() => {
    if (job.child === child) terminateProcessTree(child, true);
  }, graceMs);
  escalation.unref();
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function uiDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "ui");
    if (existsSync(join(candidate, "index.html"))) return candidate;
    dir = dirname(dir);
  }
  throw new Error("Engine ui/ not found.");
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Tool payloads are small; anything larger is a mistake or an attack.
    if (size > 8 * 1024 * 1024) throw new Error("Request body too large.");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

export interface HttpServerHandle {
  server: Server;
  /** Bind to loopback and return the port actually taken. */
  listen: (preferred: number) => Promise<number>;
  port: () => number;
  /** Stop watchers, timers and any running draw agents. Safe to call twice. */
  shutdown: () => void;
}

export function createHttpServer(options: HttpServerOptions): HttpServerHandle {
  const { registry, token, log } = options;
  const jobs = new Map<string, IndexJob>();
  const indexingRoots = new Set<string>();
  const activeMcpSessions = new Set<() => void>();
  const mcpSessions = new Map<string, ActiveMcpSession>();
  const removedRoots = new Set<string>();
  let boundPort = 0;
  let watchEnabled = process.env.SDLC_WATCH !== "0";

  /**
   * Re-parsing invalidates the typed refs for the files that changed, so a
   * watch rescan leaves precision degraded until this runs. It is debounced
   * far harder than the scan itself because it is a full type-check — paying
   * that on every save would make watching worse than not watching.
   */
  const typedTimers = new Map<string, NodeJS.Timeout>();
  const typedControllers = new Map<string, Set<AbortController>>();
  const typedRuns = new Map<string, Set<Promise<void>>>();

  async function cancelTypedPasses(root: string): Promise<void> {
    const timer = typedTimers.get(root);
    if (timer) clearTimeout(timer);
    typedTimers.delete(root);
    for (const controller of typedControllers.get(root) ?? []) controller.abort();
    await Promise.allSettled(typedRuns.get(root) ?? []);
    typedControllers.delete(root);
    typedRuns.delete(root);
  }

  async function runTypedPass(root: string) {
    if (removedRoots.has(root)) return null;
    const controller = new AbortController();
    const active = typedControllers.get(root) ?? new Set<AbortController>();
    active.add(controller);
    typedControllers.set(root, active);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runs = typedRuns.get(root) ?? new Set<Promise<void>>();
    runs.add(finished);
    typedRuns.set(root, runs);
    try {
      const db = await getDb(root);
      const typed = await resolveTypesInWorker(db, root, controller.signal);
      return removedRoots.has(root) ? null : { db, typed };
    } finally {
      active.delete(controller);
      if (active.size === 0) typedControllers.delete(root);
      finish();
      runs.delete(finished);
      if (runs.size === 0) typedRuns.delete(root);
    }
  }

  function scheduleTypedPass(root: string): void {
    if (removedRoots.has(root)) return;
    const existing = typedTimers.get(root);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      typedTimers.delete(root);
      void (async () => {
        try {
          const pass = await runTypedPass(root);
          if (!pass) return;
          const { db, typed } = pass;
          if (typed.ran) {
            await db.flush();
            await registry.markUpdated(root);
            log(`typed ${root}: ${typed.resolved} refs in ${typed.durationMs}ms`);
          } else if (typed.reason?.includes("changed while resolving")) {
            scheduleTypedPass(root);
          }
        } catch (error) {
          if (removedRoots.has(root)) return;
          log(`typed pass failed for ${root}: ${error instanceof Error ? error.message : error}`);
        }
      })();
    }, 15_000);
    timer.unref();
    typedTimers.set(root, timer);
  }

  /**
   * A watched change triggers a scan, never the analyser pass. Re-running the
   * project's linters on every save would be intolerable; keeping the graph
   * current is what the index is for. Typed resolution is separately debounced.
   */
  const watchRefresh = new WatchRefreshQueue({
    blocked: (root) => indexingRoots.has(root),
    refresh: async (root, paths) => {
      const result = await scan(root, { kind: "watch" });
      if (removedRoots.has(root)) return;
      await registry.markIndexed(root);
      log(`rescanned ${root}: ${result.filesParsed} parsed, ${result.references} refs`);
      // Deletions and compiler config changes can invalidate typed rows even
      // when no source file was parsed by the incremental pass.
      if (
        result.filesParsed > 0 ||
        result.filesRemoved > 0 ||
        hasTypedConfigChange(paths)
      ) {
        scheduleTypedPass(root);
      }
    },
    onError: (root, error) => {
      log(`watch rescan failed for ${root}: ${error instanceof Error ? error.message : error}`);
    },
  });

  const watcher = new WorkspaceWatcher({
    log,
    onChange: (root, changed, paths) => {
      log(`${changed} file(s) changed in ${root}`);
      watchRefresh.enqueue(root, paths);
    },
  });

  async function syncWatchers(): Promise<void> {
    if (!watchEnabled) {
      watcher.stopAll();
      return;
    }
    watcher.sync((await registry.list()).map((workspace) => workspace.root));
  }

  async function workspaceStatuses(): Promise<WorkspaceStatus[]> {
    const workspaces = await registry.list();
    return Promise.all(
      workspaces.map(async (workspace) => {
        const job = jobs.get(workspace.id);
        const base = {
          ...workspace,
          indexing: job?.running ?? false,
          phase: job?.phase ?? null,
          events: job?.events ?? [],
          jobError: job?.error ?? null,
        };
        try {
          const db = await getDb(workspace.root);
          const indexedFiles = db.count("SELECT COUNT(*) AS n FROM files WHERE present = 1");
          return {
            ...base,
            indexedFiles,
            symbols: db.count("SELECT COUNT(*) AS n FROM symbols"),
            edges: db.count("SELECT COUNT(*) AS n FROM edges"),
            openFindings: db.count(
              "SELECT COUNT(*) AS n FROM findings WHERE status IN ('open','regressed')",
            ),
            suggestedNext:
              indexedFiles === 0
                ? "audit_scan"
                : db.count("SELECT COUNT(*) AS n FROM tool_runs") === 0
                  ? "audit_run_tools"
                  : loadPlan(db).length === 0
                    ? "audit_plan"
                    : "audit_report",
          };
        } catch {
          // An unreadable store should not blank the whole list.
          return { ...base, indexedFiles: 0, symbols: 0, edges: 0, openFindings: 0, suggestedNext: null };
        }
      }),
    );
  }

  function startIndexing(id: string, root: string, draw: string | null = null): void {
    const existing = jobs.get(id);
    if (existing?.running) return;

    const job: IndexJob = {
      running: true,
      startedAt: new Date().toISOString(),
      error: null,
      phase: "scanning",
      events: [],
      child: null,
      stopped: false,
      finished: Promise.resolve(),
    };
    jobs.set(id, job);
    indexingRoots.add(root);
    log(`indexing ${root}`);

    const note = (text: string): void => {
      job.events.push({ at: new Date().toISOString(), text });
      if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
    };

    job.finished = (async () => {
      try {
        note("Scanning files");
        await scan(root, { kind: "incremental" });
        if (job.stopped || removedRoots.has(root)) {
          job.phase = "failed";
          job.error = "Stopped.";
          return;
        }

        // Upgrade references from import-resolved to type-resolved. This is a
        // full type-check, so it runs last and only here — the point of a
        // daemon is that it can afford work a per-session process cannot.
        const pass = await runTypedPass(root);
        if (!pass) return;
        const { db, typed } = pass;
        if (typed.ran) {
          // The scan has flushed; persist the worker's upgraded references
          // before the app can be closed.
          await db.flush();
          log(`typed ${root}: ${typed.resolved} refs in ${typed.durationMs}ms`);
        } else if (typed.reason?.includes("changed while resolving")) {
          scheduleTypedPass(root);
        }

        await registry.markIndexed(root);
        log(`indexed ${root}`);
        note("Index built");

        // The scan is finished and useful on its own. Drawing is opt-in
        // because it spends real tokens in the user's harness — nothing here
        // should quietly run an agent on their account. A stop pressed
        // during the scan also lands here: the phases before this point are
        // cheap and local, the one after spends tokens.
        if (!draw || job.stopped) {
          job.phase = job.stopped ? "failed" : "done";
          return;
        }

        job.phase = "drawing";
        note(`Asking ${draw} to draw the map`);
        const handle = await drawMap({
          harness: draw,
          root,
          bridge: options.bridge,
          onEvent: note,
        });
        job.child = handle.child;
        if (job.stopped) terminateProcessTree(handle.child);
        const result = await handle.finished;
        job.child = null;
        note(result.summary);
        job.phase = !job.stopped && result.ok ? "done" : "failed";
        job.error = job.stopped ? "Stopped." : result.ok ? null : result.summary;
        log(`draw ${root}: ${result.summary}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        job.phase = "failed";
        job.error = message;
        job.child = null;
        note(message);
        log(`build failed for ${root}: ${message}`);
      } finally {
        job.running = false;
        indexingRoots.delete(root);
        // Files changed during the scan or drawing pass were retained by the
        // queue; release them now instead of waiting for another edit.
        watchRefresh.resume(root);
      }
    })();
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ): Promise<boolean> {
    const method = req.method ?? "GET";

    if (path === "/api/shutdown" && method === "POST") {
      sendJson(res, 202, { ok: true });
      // Let the acknowledgement drain before server.close() starts rejecting
      // new work. The daemon owns lock cleanup and process termination.
      setImmediate(() => options.onShutdownRequested?.());
      return true;
    }

    if (path === "/api/health") {
      sendJson(res, 200, { ok: true, version: ENGINE_VERSION });
      return true;
    }

    if (path === "/api/status" && method === "GET") {
      const status: EngineStatus = {
        version: ENGINE_VERSION,
        startedAt: STARTED_AT,
        pid: process.pid,
        port: boundPort,
        workspaces: (await registry.list()).length,
        watching: watchEnabled ? watcher.roots.length : 0,
      };
      sendJson(res, 200, status);
      return true;
    }

    if (path === "/api/search" && method === "GET") {
      const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
      const term = query.get("q");
      if (!term) {
        sendJson(res, 400, { error: "Provide q." });
        return true;
      }
      const kind = (query.get("kind") ?? "symbol") as CrossKind;
      if (!CROSS_KINDS.includes(kind)) {
        sendJson(res, 400, { error: `kind must be one of ${CROSS_KINDS.join(", ")}` });
        return true;
      }
      const workspaces = (await registry.list()).map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        root: workspace.root,
      }));
      sendJson(res, 200, await crossQuery(workspaces, kind, term));
      return true;
    }

    if (path === "/api/watch") {
      if (method === "POST") {
        const body = (await readBody(req)) as { enabled?: boolean } | undefined;
        watchEnabled = body?.enabled !== false;
        await syncWatchers();
        log(`watch ${watchEnabled ? "enabled" : "disabled"}`);
      }
      sendJson(res, 200, { enabled: watchEnabled, watching: watcher.roots.length });
      return true;
    }

    if (path === "/api/workspaces" && method === "GET") {
      sendJson(res, 200, await workspaceStatuses());
      return true;
    }

    if (path === "/api/workspaces" && method === "POST") {
      const body = (await readBody(req)) as { root?: string } | undefined;
      if (!body?.root) {
        sendJson(res, 400, { error: "Provide a root path." });
        return true;
      }
      if (!isWorkspaceDirectory(body.root)) {
        sendJson(res, 400, { error: `No such directory: ${body.root}` });
        return true;
      }
      const created = await registry.add(body.root);
      removedRoots.delete(created.root);
      await syncWatchers();
      sendJson(res, 201, created);
      return true;
    }

    // Suppress a finding from the UI — the same path audit_suppress writes.
    const suppressMatch = /^\/api\/workspaces\/([a-f0-9]{12})\/findings\/([a-f0-9]+)\/suppress$/.exec(
      path,
    );
    if (suppressMatch && method === "POST") {
      const workspace = await registry.get(suppressMatch[1] as string);
      if (!workspace) {
        sendJson(res, 404, { error: "Unknown workspace." });
        return true;
      }
      const body = (await readBody(req)) as
        | { reason?: string; disposition?: "accepted" | "false_positive" }
        | undefined;
      if (!body?.reason?.trim()) {
        sendJson(res, 400, { error: "A reason is required." });
        return true;
      }
      if (
        body.disposition !== undefined &&
        body.disposition !== "accepted" &&
        body.disposition !== "false_positive"
      ) {
        sendJson(res, 400, { error: "disposition must be accepted or false_positive." });
        return true;
      }
      const db = await getDb(workspace.root);
      suppress(db, {
        findingId: suppressMatch[2] as string,
        reason: body.reason.trim(),
        disposition: body.disposition,
      });
      await db.flush();
      sendJson(res, 200, {
        suppressed: suppressMatch[2],
        disposition: body.disposition ?? "false_positive",
      });
      return true;
    }

    const workspaceMatch =
      /^\/api\/workspaces\/([a-f0-9]{12})(?:\/(index|stop|graph|flow|map|component|findings|overview|file|memories|report|review))?$/.exec(
        path,
      );
    if (workspaceMatch) {
      const id = workspaceMatch[1] as string;
      const sub = workspaceMatch[2];
      const workspace = await registry.get(id);
      if (!workspace) {
        sendJson(res, 404, { error: "Unknown workspace." });
        return true;
      }

      if (sub === "index" && method === "POST") {
        const body = (await readBody(req)) as { draw?: string | null } | undefined;
        const draw = body?.draw ?? null;
        if (draw && !supportedHarnesses().includes(draw)) {
          sendJson(res, 400, {
            error: `Cannot drive "${draw}". Supported: ${supportedHarnesses().join(", ")}.`,
          });
          return true;
        }
        startIndexing(id, workspace.root, draw);
        sendJson(res, 202, { started: true, draw });
        return true;
      }

      // Stop a running build. During the scan there is no child yet, so the
      // flag is what prevents the draw phase from starting; during a draw
      // the child gets SIGTERM, then SIGKILL if it is still there on a
      // second press. The child reference is cleared by the pipeline when
      // the process actually exits — nulling it here would orphan a child
      // that ignores SIGTERM with no way left to reach it.
      if (sub === "stop" && method === "POST") {
        const job = jobs.get(id);
        if (job) requestIndexStop(job);
        sendJson(res, 200, { stopped: true });
        return true;
      }

      if (!sub && method === "DELETE") {
        const job = jobs.get(id);
        removedRoots.add(workspace.root);
        // A tool request can hold the same sql.js image independently of the
        // desktop's index jobs. Stop only sessions that touched this workspace,
        // then wait for their handlers to release the handle before eviction.
        const workspaceSessions = [...new Set(mcpSessions.values())].filter((session) =>
          session.roots.has(workspace.root),
        );
        for (const session of workspaceSessions) session.close();
        if (job) requestIndexStop(job);
        await cancelTypedPasses(workspace.root);
        await watchRefresh.discard(workspace.root);
        if (job) await job.finished;
        await Promise.allSettled(
          workspaceSessions.flatMap((session) => [
            ...session.requests,
            ...session.registrations,
          ]),
        );
        await registry.remove(id);
        jobs.delete(id);
        await syncWatchers();
        await closeDb(workspace.root);
        sendJson(res, 200, { removed: true });
        return true;
      }

      // Read models. All of them are queries against this workspace's store.
      if (method === "GET" && sub) {
        const db = await getDb(workspace.root);
        const query = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;

        if (sub === "graph") {
          const limit = Math.min(Number(query.get("limit") ?? 120), 400);
          sendJson(res, 200, graphView(db, limit));
          return true;
        }
        if (sub === "flow") {
          const root = query.get("root");
          sendJson(
            res,
            200,
            flowView(db, {
              ...(root ? { root } : {}),
              ...(query.get("rootId") ? { rootId: query.get("rootId") as string } : {}),
              ...(query.get("rootPath") ? { rootPath: query.get("rootPath") as string } : {}),
              ...(query.get("depth") ? { depth: Number(query.get("depth")) } : {}),
            }),
          );
          return true;
        }
        if (sub === "map") {
          sendJson(res, 200, systemMap(db));
          return true;
        }
        if (sub === "component") {
          const target = query.get("id");
          if (!target) {
            sendJson(res, 400, { error: "Provide a component id." });
            return true;
          }
          const detail = componentDetail(db, target);
          if (!detail) sendJson(res, 404, { error: "Unknown component." });
          else sendJson(res, 200, detail);
          return true;
        }
        if (sub === "findings") {
          sendJson(res, 200, findingsView(db, 300, query.get("status") ?? "open"));
          return true;
        }
        if (sub === "overview") {
          sendJson(res, 200, overviewView(db));
          return true;
        }
        if (sub === "memories") {
          sendJson(res, 200, memoriesView(db));
          return true;
        }
        if (sub === "report") {
          sendJson(res, 200, buildReports(db));
          return true;
        }
        if (sub === "file") {
          const target = query.get("path");
          if (!target) {
            sendJson(res, 400, { error: "Provide a path." });
            return true;
          }
          const view = fileView(db, target);
          if (!view) sendJson(res, 404, { error: "Unknown file." });
          else sendJson(res, 200, view);
          return true;
        }
      }
    }

    if (path === "/api/harnesses" && method === "GET") {
      sendJson(res, 200, await detectHarnesses());
      return true;
    }

    const harnessMatch = /^\/api\/harnesses\/([a-z-]+)\/(connect|disconnect)$/.exec(path);
    if (harnessMatch && method === "POST") {
      const [, id, action] = harnessMatch as unknown as [string, string, string];
      try {
        if (action === "connect") await connectHarness(id, options.bridge);
        else await disconnectHarness(id);
        log(`${action}ed ${id}`);
        sendJson(res, 200, { ok: true, harnesses: await detectHarnesses(true) });
      } catch (error) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    return false;
  }

  async function handleUi(res: ServerResponse, path: string): Promise<void> {
    const root = uiDir();
    // The leading slash must go: with it, "/index.html" never equals
    // "index.html" below and the page ships with its token placeholder
    // unfilled — a UI where every call 401s.
    const relative =
      path === "/"
        ? "index.html"
        : normalize(path)
            .replace(/^(\.\.[/\\])+/, "")
            .replace(/^[/\\]+/, "");
    const file = join(root, relative);

    // Never serve outside ui/, whatever the request path claims.
    if (!file.startsWith(root)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }

    try {
      let body: string | Buffer = await readFile(file);
      const type = MIME[extname(file)] ?? "application/octet-stream";

      // The page needs a token to call the API it was just served from.
      if (relative === "index.html") {
        body = body
          .toString("utf-8")
          .replace("__SDLC_BOOTSTRAP__", JSON.stringify({ token, port: boundPort }));
      }

      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    } catch {
      sendJson(res, 404, { error: "Not found" });
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      const path = requestPath(req.url);
      if (path === null) {
        sendJson(res, 400, { error: "Bad request: malformed URL." });
        return;
      }

      // Everything is loopback-and-same-origin only.
      const origin = checkOrigin(req, boundPort);
      if (!origin.ok) {
        sendJson(res, origin.status, { error: origin.message });
        return;
      }

      // The API and MCP use bearer auth. The HTML shell needs a one-time
      // navigation credential before it may receive that same token.
      const needsToken = path === "/mcp" || path.startsWith("/api/");
      if (needsToken) {
        const auth = checkToken(req, token);
        if (!auth.ok) {
          sendJson(res, auth.status, { error: auth.message });
          return;
        }
      }
      if (path === "/" || path === "/index.html") {
        const auth = checkUiBootstrap(req, token);
        if (!auth.ok) {
          sendJson(res, auth.status, { error: auth.message });
          return;
        }
      }

      try {
        if (path === "/mcp") {
          await handleMcp(req, res);
          return;
        }
        if (path.startsWith("/api/")) {
          if (await handleApi(req, res, path)) return;
          sendJson(res, 404, { error: "Unknown endpoint." });
          return;
        }
        await handleUi(res, path);
      } catch (error) {
        log(`request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) {
          sendJson(res, 500, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
  });

  async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      sendJson(res, 405, { error: "Unsupported MCP method." });
      return;
    }

    const body = method === "POST" ? await readBody(req) : undefined;
    const rawSessionId = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

    if (sessionId) {
      const session = mcpSessions.get(sessionId);
      if (!session) {
        sendJson(res, 404, { error: "Unknown MCP session." });
        return;
      }
      await handleMcpSessionRequest(session, req, res, body);
      return;
    }

    if (method !== "POST" || !isInitializeRequest(body)) {
      sendJson(res, 400, { error: "MCP initialization requires a new session." });
      return;
    }

    let session!: ActiveMcpSession;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        mcpSessions.set(id, session);
      },
    });
    const mcp = createMcpServer({
      defaultRoot: null,
      // Watch what agents register, not just what the UI adds — otherwise a
      // repo first seen through the bridge is never watched until a restart.
      onWorkspaceTouched: (root) => {
        session.roots.add(root);
        const registration = registry
          .add(root)
          .then((workspace) => {
            session.roots.add(workspace.root);
            // A delete may close this session while its initial registration
            // is still queued. Do not let that stale completion resurrect the
            // workspace after the user removed it.
            if (session.closed && removedRoots.has(workspace.root)) {
              return registry.remove(workspace.id).then(() => {});
            }
            removedRoots.delete(workspace.root);
            return syncWatchers();
          })
          .catch(() => {})
          .finally(() => session.registrations.delete(registration));
        session.registrations.add(registration);
        void registration;
      },
      onWorkspaceChanged: async (root, kind) => {
        // Registration and publication are one awaited operation here. The
        // touch callback is intentionally fire-and-forget and may still be in
        // flight when a fast MCP write completes.
        const workspace = await registry.add(root);
        session.roots.add(workspace.root);
        removedRoots.delete(workspace.root);
        if (kind === "indexed") await registry.markIndexed(root);
        else await registry.markUpdated(root);
        await syncWatchers();
      },
      listWorkspaces: async () =>
        (await registry.list()).map((workspace) => ({
          id: workspace.id,
          name: workspace.name,
          root: workspace.root,
        })),
    });
    let closed = false;
    const closeSession = (): void => {
      if (closed) return;
      closed = true;
      session.closed = true;
      const id = transport.sessionId;
      if (id && mcpSessions.get(id)?.transport === transport) mcpSessions.delete(id);
      activeMcpSessions.delete(closeSession);
      void mcp.close().catch((error) => {
        log(`MCP session close failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    session = {
      transport,
      close: closeSession,
      roots: new Set(),
      requests: new Set(),
      registrations: new Set(),
      closed: false,
    };
    transport.onclose = closeSession;
    activeMcpSessions.add(closeSession);

    try {
      await mcp.connect(transport);
      await handleMcpSessionRequest(session, req, res, body);
    } catch (error) {
      closeSession();
      throw error;
    }
  }

  async function handleMcpSessionRequest(
    session: ActiveMcpSession,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
  ): Promise<void> {
    const handling = session.transport.handleRequest(req, res, body);
    session.requests.add(handling);
    try {
      await handling;
    } finally {
      session.requests.delete(handling);
    }
  }

  /**
   * Bind to loopback, preferring a stable port so the UI keeps one URL.
   * Falls back to an ephemeral port when that one is taken — the bridge
   * reads the real port from daemon.json, so nothing downstream cares.
   */
  function listen(preferred: number): Promise<number> {
    return new Promise((resolvePort, reject) => {
      const bind = (port: number, allowFallback: boolean): void => {
        const onError = (error: NodeJS.ErrnoException): void => {
          if (allowFallback && error.code === "EADDRINUSE") {
            log(`port ${port} busy, falling back to an ephemeral port`);
            server.removeListener("error", onError);
            bind(0, false);
            return;
          }
          reject(error);
        };

        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.removeListener("error", onError);
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Server bound to a non-TCP address."));
            return;
          }
          boundPort = address.port;
          void syncWatchers();
          resolvePort(boundPort);
        });
      };

      bind(preferred, preferred !== 0);
    });
  }

  function shutdown(): void {
    watcher.stopAll();
    for (const timer of typedTimers.values()) clearTimeout(timer);
    typedTimers.clear();
    for (const controllers of typedControllers.values()) {
      for (const controller of controllers) controller.abort();
    }
    typedControllers.clear();
    // Closing an MCP server aborts every in-flight handler signal. Reviews
    // propagate that signal to their Claude process trees.
    for (const closeSession of [...activeMcpSessions]) closeSession();
    // Draw agents are separate from MCP requests and need direct termination.
    for (const job of jobs.values()) {
      job.stopped = true;
      if (job.child) terminateProcessTree(job.child);
    }
  }

  // server.close() waits for open connections; the daemon's forced-exit
  // fallback does not, so shutdown() is also called directly on signals.
  server.on("close", shutdown);

  return { server, listen, port: () => boundPort, shutdown };
}

const STARTED_AT = new Date().toISOString();
