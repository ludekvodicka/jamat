import http from "node:http";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { hostname } from "node:os";
import { createHash, timingSafeEqual } from "node:crypto";

import { loadConfig, ensureConfig, firstRunConfigMessage } from "../core/config.js";
import { resolveConfigDir } from "../core/config-dir.js";
import { REMOTE_CONTROL_FILE } from "../core/paths.js";
import { MIN_TOKEN_LEN } from "../core/types/remote-control.js";
import { isGatedApiPath } from "./api-gate.js";
import { SESSION_ID_RE, DEFAULT_AGENT_ID } from "../core/types.js";
import { getAgent } from "../core/agents/index.js";
import { loadStats, saveStats, recordUsage, statsKey, getStatsPath } from "../core/menu-core/stats.js";
import { getFolders, loadProjectConfig, moveProjectPrefix } from "../core/menu-core/projects.js";
import { findProjectDir, loadSessionsForProject, loadSessionPreview } from "../core/agents/claude/sessions.js";
import { buildLaunchCommand } from "../core/executor/agent-launcher.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DOCKER_CONTEXT_DIR = path.join(MONOREPO_ROOT, "dockerized-claude");

const argOf = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  if (i === -1) return null;
  if (i + 1 >= process.argv.length) { console.error(`Usage: agent-server.ts ${flag} <value>`); process.exit(1); }
  return process.argv[i + 1];
};
const explicitConfig = argOf("--config");                                       // explicit config FILE
const explicitConfigDir = argOf("--config-dir") ?? process.env["JAMAT_CONFIG_DIR"] ?? null;
// Portable config-dir (default ~/.jamat). Agent is build-agnostic → PROD (no -debug). Shared by the
// data writers (usage-stats) + remote-control.json so the agent + electron + CLI agree on one dir.
// Precedence: --config-dir / JAMAT_CONFIG_DIR → the dir of an explicit --config FILE (so passing just
// `--config <dir>/config.json` also points the key/state at that dir, matching electron) → ~/.jamat.
const CONFIG_DIR = resolveConfigDir({
  explicit: explicitConfigDir ?? (explicitConfig ? path.dirname(path.resolve(explicitConfig)) : null),
});

// An explicit --config FILE must exist (fail fast on a typo). Otherwise default to
// <config-dir>/config.json, first-run-creating a starter so a fresh clone runs without manual setup.
let configPath: string;
try {
  if (explicitConfig) {
    const abs = path.resolve(explicitConfig);
    if (!existsSync(abs)) {
      console.error(`Config file not found: ${abs}`);
      process.exit(1);
    }
    configPath = abs;
  } else {
    const r = ensureConfig(path.join(CONFIG_DIR, "config.json"), path.join(MONOREPO_ROOT, "configs", "config.example.json"));
    configPath = r.path;
    if (r.created) console.log("\n" + firstRunConfigMessage(configPath) + "\n");
  }
} catch (e) {
  console.error("[config] First-run setup failed:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
const appConfig = loadConfig(configPath);
const STATS_FILE = getStatsPath(CONFIG_DIR);

const portIdx = process.argv.indexOf("--port");
const PORT = portIdx !== -1 ? parseInt(process.argv[portIdx + 1], 10) : 3501;

const categories = appConfig.categories;

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res: http.ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

const MAX_BODY = 1024 * 1024;

async function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > MAX_BODY) {
        reject(Object.assign(new Error("Body too large"), { httpStatus: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { httpStatus: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// Map a readBody rejection to the right HTTP status: oversize → 413, malformed → 400.
function bodyError(res: http.ServerResponse, e: unknown) {
  const tooLarge = !!e && typeof e === "object" && (e as { httpStatus?: number }).httpStatus === 413;
  return tooLarge ? error(res, "Request body too large", 413) : error(res, "Invalid JSON body");
}

function findCategory(label: string) {
  return categories.find((c) => c.label === label);
}


function isValidName(name: string): boolean {
  return typeof name === "string" && name.length > 0
    && !name.includes("..") && !name.includes("/") && !name.includes("\\")
    && !path.isAbsolute(name);
}

function safePath(basePath: string, name: string): string | null {
  if (!isValidName(name)) return null;
  const resolved = path.resolve(basePath, name);
  if (!resolved.startsWith(path.resolve(basePath) + path.sep)) return null;
  return resolved;
}

const trackedProcesses: Map<number, { category: string; project: string; startedAt: string }> = new Map();

// --- Log buffer for debug API ---
const logBuffer: Array<{ ts: number; level: string; message: string }> = [];
const MAX_LOGS = 500;
const origLog = console.log;
const origError = console.error;
console.log = (...args: any[]) => {
  origLog(...args);
  logBuffer.push({ ts: Date.now(), level: 'info', message: args.map(String).join(' ') });
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
};
console.error = (...args: any[]) => {
  origError(...args);
  logBuffer.push({ ts: Date.now(), level: 'error', message: args.map(String).join(' ') });
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
};

function cleanDeadProcesses() {
  for (const [pid] of trackedProcesses) {
    try {
      process.kill(pid, 0);
    } catch {
      trackedProcesses.delete(pid);
    }
  }
}

// --- Route handlers ---

function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse) {
  json(res, { ok: true, hostname: hostname(), uptime: process.uptime() });
}

function handleGetProjects(_req: http.IncomingMessage, res: http.ServerResponse) {
  const stats = loadStats(STATS_FILE);
  const result = categories.map((cat) => {
    const folders = getFolders(cat, stats);
    return {
      label: cat.label,
      virtualFolders: cat.virtualFolders,
      projects: folders.map((name) => {
        const entry = stats[statsKey(cat, name)];
        const config = loadProjectConfig(path.join(cat.path, name));
        return {
          name,
          isolated: config.isolated,
          usageCount: entry?.count ?? 0,
          lastUsed: entry?.lastUsed ?? null,
        };
      }),
    };
  });
  json(res, { categories: result });
}

function handleGetSessions(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url!, `http://localhost`);
  const projectParam = url.searchParams.get("project");
  if (!projectParam) return error(res, "Missing ?project= parameter");

  const [catLabel, projectName] = projectParam.split("/", 2);
  const cat = findCategory(catLabel);
  if (!cat || !projectName) return error(res, "Invalid project path");
  if (!isValidName(projectName)) return error(res, "Invalid project name", 400);

  const folderPath = path.join(cat.path, projectName);
  const projectDir = findProjectDir(folderPath);
  if (!projectDir) return json(res, { sessions: [] });

  const sessions = loadSessionsForProject(projectDir);
  json(res, {
    sessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      slug: s.slug,
      firstUserMessage: s.firstUserMessage,
      lastActivity: new Date(s.lastActivity).toISOString(),
      active: s.active,
    })),
  });
}

function handleGetSessionPreview(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url!, `http://localhost`);
  const projectParam = url.searchParams.get("project");
  const sessionId = url.searchParams.get("sessionId");
  if (!projectParam || !sessionId) return error(res, "Missing ?project= and ?sessionId= parameters");
  if (!SESSION_ID_RE.test(sessionId)) return error(res, "Invalid sessionId format", 400);

  const [catLabel, projectName] = projectParam.split("/", 2);
  const cat = findCategory(catLabel);
  if (!cat || !projectName) return error(res, "Invalid project path");
  if (!isValidName(projectName)) return error(res, "Invalid project name", 400);

  const folderPath = path.join(cat.path, projectName);
  const projectDir = findProjectDir(folderPath);
  if (!projectDir) return json(res, { messages: [] });

  const messages = loadSessionPreview(projectDir, sessionId);
  json(res, { messages });
}

async function handleLaunch(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try {
    body = await readBody(req);
  } catch (e) {
    return bodyError(res, e);
  }

  const { category, project, mode, sessionId } = body;
  if (!category || !project || !mode) return error(res, "Missing category, project, or mode");
  const validModes = ['cc', 'ccc', 'resume', 'resume-fork'];
  if (!validModes.includes(mode)) return error(res, `Invalid mode: ${mode}`, 400);

  const cat = findCategory(category);
  if (!cat) return error(res, `Unknown category: ${category}`);

  const projectDir = safePath(cat.path, project);
  if (!projectDir) return error(res, "Invalid project name", 400);
  if (!existsSync(projectDir)) return error(res, `Project not found: ${project}`, 404);

  if (sessionId && !SESSION_ID_RE.test(sessionId)) {
    return error(res, "Invalid sessionId format", 400);
  }

  const cmd = buildLaunchCommand({
    selection: {
      dir: projectDir,
      cmd: mode as 'cc' | 'ccc' | 'resume' | 'resume-fork',
      folderName: project,
      isolated: loadProjectConfig(projectDir).isolated,
      antiFlicker: false,
      sessionId,
      // Remote web-agent path uses the config's default. A future
      // remote payload could carry an `agent` query param to override
      // per-call.
      agent: appConfig.defaultAgent ?? DEFAULT_AGENT_ID,
    },
    mode: 'detached',
    dockerContextDir: DOCKER_CONTEXT_DIR,
  });

  const stats = loadStats(STATS_FILE);
  recordUsage(STATS_FILE, stats, cat, project);

  // Launch in a visible Windows Terminal tab so user sees what's happening
  const agentId = appConfig.defaultAgent ?? DEFAULT_AGENT_ID;
  const title = `${project} - ${getAgent(agentId).displayName} (Remote)`;
  const claudeArgs = cmd.args.join(' ');
  const envSetup = Object.entries(cmd.env)
    .map(([k, v]) => `set "${k}=${v}"`)
    .join(' && ');
  const fullCmd = envSetup ? `${envSetup} && ${cmd.command} ${claudeArgs}` : `${cmd.command} ${claudeArgs}`;

  const child = spawn('wt.exe', [
    'new-tab', '--title', title, '-d', cmd.cwd,
    'cmd.exe', '/k', fullCmd,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  child.on("error", (err) => {
    console.error("Failed to spawn claude:", err.message);
  });

  const pid = child.pid;
  if (pid) {
    trackedProcesses.set(pid, {
      category: cat.label,
      project,
      startedAt: new Date().toISOString(),
    });
  }

  json(res, { ok: true, pid: pid ?? null });
}

async function handleProjectCreate(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try { body = await readBody(req); } catch (e) { return bodyError(res, e); }

  const { category, name, isolated } = body;
  if (!category || !name) return error(res, "Missing category or name");

  const cat = findCategory(category);
  if (!cat) return error(res, `Unknown category: ${category}`);

  const folderPath = safePath(cat.path, name);
  if (!folderPath) return error(res, "Invalid project name", 400);
  if (existsSync(folderPath)) return error(res, `Project already exists: ${name}`, 409);

  mkdirSync(folderPath, { recursive: true });
  if (isolated) {
    writeFileSync(path.join(folderPath, ".jamat.json"), JSON.stringify({ isolated: true }, null, 2) + "\n");
  }
  json(res, { ok: true, path: folderPath });
}

async function handleProjectArchive(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try { body = await readBody(req); } catch (e) { return bodyError(res, e); }

  const { category, project } = body;
  if (!category || !project) return error(res, "Missing category or project");

  const cat = findCategory(category);
  if (!cat) return error(res, `Unknown category: ${category}`);

  const folderPath = safePath(cat.path, project);
  if (!folderPath) return error(res, "Invalid project name", 400);
  if (!existsSync(folderPath)) return error(res, `Project not found: ${project}`, 404);

  const archiveDir = path.join(cat.path, "Archived");
  mkdirSync(archiveDir, { recursive: true });
  renameSync(folderPath, path.join(archiveDir, project));
  json(res, { ok: true });
}

async function handleProjectUnarchive(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try { body = await readBody(req); } catch (e) { return bodyError(res, e); }

  const { category, project } = body;
  if (!category || !project) return error(res, "Missing category or project");

  const cat = findCategory(category);
  if (!cat) return error(res, `Unknown category: ${category}`);

  if (!isValidName(project)) return error(res, "Invalid project name", 400);
  const archivedPath = path.join(cat.path, "Archived", project);
  if (!existsSync(archivedPath)) return error(res, `Archived project not found: ${project}`, 404);

  renameSync(archivedPath, path.join(cat.path, project));
  json(res, { ok: true });
}

async function handleProjectDelete(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try { body = await readBody(req); } catch (e) { return bodyError(res, e); }

  const { category, project, confirm } = body;
  if (!category || !project) return error(res, "Missing category or project");
  if (confirm !== true) return error(res, "Must include confirm: true to delete");

  const cat = findCategory(category);
  if (!cat) return error(res, `Unknown category: ${category}`);

  const folderPath = safePath(cat.path, project);
  if (!folderPath) return error(res, "Invalid project name", 400);
  if (!existsSync(folderPath)) return error(res, `Project not found: ${project}`, 404);

  rmSync(folderPath, { recursive: true, force: true });
  json(res, { ok: true });
}

async function handleMovePrefix(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try { body = await readBody(req); } catch (e) { return bodyError(res, e); }

  const { category, project, targetPrefix } = body;
  if (!category || !project || targetPrefix === undefined) return error(res, "Missing category, project, or targetPrefix");

  const cat = findCategory(category);
  if (!cat) return error(res, `Unknown category: ${category}`);
  if (!isValidName(project)) return error(res, "Invalid project name", 400);

  try {
    const result = moveProjectPrefix(cat, project, targetPrefix);
    json(res, { ok: true, ...result });
  } catch (e: any) {
    error(res, e.message, 400);
  }
}

async function handleClearStats(req: http.IncomingMessage, res: http.ServerResponse) {
  let body: any;
  try { body = await readBody(req); } catch (e) { return bodyError(res, e); }

  const { category, project } = body;
  if (!category || !project) return error(res, "Missing category or project");

  const cat = findCategory(category);
  if (!cat) return error(res, `Unknown category: ${category}`);

  const stats = loadStats(STATS_FILE);
  const sk = statsKey(cat, project);
  delete stats[sk];
  saveStats(STATS_FILE, stats);
  json(res, { ok: true });
}

function handleStatus(_req: http.IncomingMessage, res: http.ServerResponse) {
  cleanDeadProcesses();
  const running = Array.from(trackedProcesses.entries()).map(([pid, info]) => ({
    pid,
    ...info,
  }));
  json(res, { running });
}

// --- Debug handlers (token-protected) ---

function checkDebugAuth(req: http.IncomingMessage): boolean {
  const token = process.env['APP_DEBUG_AI_TOKEN'];
  if (!token) return false;
  const authHeader = req.headers['authorization'];
  const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  if (!provided) return false;
  return timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(token).digest());
}

function requireDebugAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (!process.env['APP_DEBUG_AI_TOKEN']) { error(res, "Debug auth not configured", 503); return false; }
  if (!checkDebugAuth(req)) { error(res, "Unauthorized", 401); return false; }
  return true;
}

function handleDebugHealth(_req: http.IncomingMessage, res: http.ServerResponse) {
  json(res, { ok: true });
}

function handleDebugInfo(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!requireDebugAuth(req, res)) return;
  cleanDeadProcesses();
  json(res, {
    app: "jamat-agent",
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    nodeVersion: process.version,
    memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    config: appConfig.name,
    categories: categories.map(c => c.label),
    trackedProcesses: trackedProcesses.size,
  });
}

function handleDebugLogs(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!requireDebugAuth(req, res)) return;
  const url = new URL(req.url!, `http://localhost`);
  const since = url.searchParams.get("since");
  const level = url.searchParams.get("level");
  let logs = [...logBuffer];
  if (since) {
    const sinceTs = parseInt(since);
    if (!isNaN(sinceTs)) logs = logs.filter(l => l.ts > sinceTs);
  }
  if (level) logs = logs.filter(l => l.level === level);
  json(res, { count: logs.length, logs });
}

function handleDebugProcesses(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!requireDebugAuth(req, res)) return;
  cleanDeadProcesses();
  const running = Array.from(trackedProcesses.entries()).map(([pid, info]) => ({ pid, ...info }));
  json(res, { running });
}

function handleDebugRestart(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!requireDebugAuth(req, res)) return;
  json(res, { ok: true, message: "Restarting in 1s" });
  setTimeout(() => process.exit(0), 1000);
}

// --- Remote App Control: launch the full Electron app when it's closed ---
// Reads the UNIFIED token from the SAME remote-control.json the Electron app uses, now resolved
// from the config-dir (CONFIG_DIR — the agent already resolves it via --config-dir / JAMAT_CONFIG_DIR,
// default ~/.jamat). No electron import. Re-read per request so a token rotation takes effect
// without restarting the agent.

function readRemoteControl(): { enabled: boolean; token: string; listenPort: number } | null {
  try {
    const p = path.join(CONFIG_DIR, REMOTE_CONTROL_FILE);
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    if (!raw || typeof raw.token !== "string") return null;
    return {
      enabled: raw.enabled === true,
      token: raw.token,
      listenPort: Number.isInteger(raw.listenPort) ? raw.listenPort : 47200,
    };
  } catch {
    return null;
  }
}

function checkControlAuth(req: http.IncomingMessage): boolean {
  // Do NOT let the control routes ride the global Access-Control-Allow-Origin:* —
  // reject any browser-driven request (a cross-origin fetch/XHR always carries
  // an Origin header; curl / the peer's main process do not).
  if (req.headers.origin) return false;
  const rc = readRemoteControl();
  if (!rc || !rc.enabled || rc.token.length < MIN_TOKEN_LEN) return false;
  const authHeader = req.headers["authorization"];
  const provided = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  if (!provided) return false;
  // Hash both sides to a fixed width before compare so the length check can't leak the token length.
  return timingSafeEqual(createHash("sha256").update(provided).digest(), createHash("sha256").update(rc.token).digest());
}

function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (v: boolean) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.setTimeout(1000, () => done(false));
  });
}

/** Allowlist launcher resolution: only an actual `jamat-<user>.bat`. */
function resolveLauncher(user: string): string | null {
  if (!/^[a-z0-9_-]+$/i.test(user)) return null;
  const dir = path.join(MONOREPO_ROOT, "app-electron");
  let bats: string[];
  try { bats = readdirSync(dir).filter((f) => /^jamat-.+\.bat$/i.test(f)); }
  catch { return null; }
  const want = `jamat-${user.toLowerCase()}.bat`;
  const match = bats.find((f) => f.toLowerCase() === want);
  return match ? path.join(dir, match) : null;
}

async function handleAppStatus(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!checkControlAuth(req)) return error(res, "Unauthorized", 401);
  const rc = readRemoteControl();
  const controlListening = rc ? await probePort(rc.listenPort) : false;
  json(res, { ok: true, controlListening });
}

function handleLaunchApp(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!checkControlAuth(req)) return error(res, "Unauthorized", 401);
  const user = (appConfig.name || "").toLowerCase();
  const bat = resolveLauncher(user);
  if (!bat) return error(res, `No launcher found for user '${user}'`, 400);
  // Detached, fire-and-forget. The .bat may recompile (tens of seconds) before
  // the window appears; the client polls /api/app-status for readiness. We only
  // INVOKE the production `cs` launcher — never modify it.
  const child = spawn(bat, [], { detached: true, stdio: "ignore", shell: true, cwd: path.dirname(bat) });
  child.unref();
  child.on("error", (err) => console.error("Failed to launch app:", err.message));
  json(res, { ok: true, launching: true, user });
}

// --- Remote "pull latest code" (for autonomous testing) ---
// Updates the agent's OWN repo (MONOREPO_ROOT) so a peer can be brought to the latest
// committed code without local shell access; the caller then restarts the app (the launcher
// recompiles on version change) and/or the agent (POST /debug/restart) to load it. Token-gated
// like /api/launch-app — RCE-adjacent (pulls + runs code), so never on the open CORS surface.
let updateInFlight = false;
function handleUpdate(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!checkControlAuth(req)) return error(res, "Unauthorized", 401);
  // Serialize: a concurrent pull (e.g. a client retry while the 120s server pull is still running)
  // would run two VCS processes on one working copy → lock/corruption. Reject the overlap.
  if (updateInFlight) return error(res, "update already in progress", 409);
  updateInFlight = true;
  // This repo's real remote is the parent SVN (its git is local-only, no remote). Prefer svn
  // when a .svn marker exists at the repo or its parent; otherwise fall back to git pull.
  let cmd = "git";
  let args: string[] = ["-C", MONOREPO_ROOT, "pull"];
  let child: ReturnType<typeof spawn>;
  try {
    // svn when a .svn marker exists at the repo or its parent; else git pull. A synchronous throw
    // here (e.g. EMFILE on spawn) must release the in-flight lock — otherwise /api/update wedges at 409.
    if (existsSync(path.join(MONOREPO_ROOT, ".svn")) || existsSync(path.join(MONOREPO_ROOT, "..", ".svn"))) {
      cmd = "svn"; args = ["update", MONOREPO_ROOT];
    }
    child = spawn(cmd, args, { shell: true });
  } catch (e: any) {
    updateInFlight = false;
    return error(res, `update failed to start: ${e?.message ?? e}`, 500);
  }
  let out = ""; let errOut = ""; let settled = false;
  const finish = (r: object) => { if (settled) return; settled = true; updateInFlight = false; clearTimeout(timer); json(res, r); };
  const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ ok: false, vcs: cmd, error: "timeout after 120s" }); }, 120_000);
  child.stdout?.on("data", (d) => { out += d.toString(); });
  child.stderr?.on("data", (d) => { errOut += d.toString(); });
  child.on("error", (e) => finish({ ok: false, vcs: cmd, error: e.message }));
  child.on("close", (code) => finish({ ok: code === 0, vcs: cmd, code, output: (out + errOut).slice(-4000) }));
}

// --- Router ---

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

const routes: Array<{ method: string; path: string; handler: Handler }> = [
  { method: "GET", path: "/api/health", handler: handleHealth },
  { method: "GET", path: "/api/projects", handler: handleGetProjects },
  { method: "GET", path: "/api/sessions", handler: handleGetSessions },
  { method: "GET", path: "/api/session-preview", handler: handleGetSessionPreview },
  { method: "POST", path: "/api/launch", handler: handleLaunch },
  { method: "POST", path: "/api/project/create", handler: handleProjectCreate },
  { method: "POST", path: "/api/project/archive", handler: handleProjectArchive },
  { method: "POST", path: "/api/project/unarchive", handler: handleProjectUnarchive },
  { method: "POST", path: "/api/project/delete", handler: handleProjectDelete },
  { method: "POST", path: "/api/project/move-prefix", handler: handleMovePrefix },
  { method: "POST", path: "/api/project/clear-stats", handler: handleClearStats },
  { method: "GET", path: "/api/status", handler: handleStatus },
  { method: "POST", path: "/api/launch-app", handler: handleLaunchApp },
  { method: "POST", path: "/api/update", handler: handleUpdate },
  { method: "GET", path: "/api/app-status", handler: handleAppStatus },
  { method: "GET", path: "/debug/health", handler: handleDebugHealth },
  { method: "GET", path: "/debug/info", handler: handleDebugInfo },
  { method: "GET", path: "/debug/logs", handler: handleDebugLogs },
  { method: "GET", path: "/debug/processes", handler: handleDebugProcesses },
  { method: "POST", path: "/debug/restart", handler: handleDebugRestart },
];

// Every /api/* route EXCEPT the unauthenticated /api/health probe now requires the machine key
// (checkControlAuth) and is kept OFF the permissive global CORS (no ACAO:*, OPTIONS→403), so a
// browser can't preflight/drive it cross-origin. This closes the formerly-open read + mutation
// routes (/api/projects, /api/sessions, /api/session-preview, /api/launch, /api/project/*) which
// were reachable keyless over the LAN via the remote-server proxy (plan 002 P5). The only
// keyless agent surface left is /api/health (the reachability probe). /debug/* keep their own
// checkDebugAuth gate. See docs/architecture/remote-app-control.md.

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost`);
  const method = req.method?.toUpperCase() ?? "GET";
  const pathname = url.pathname;

  // Gated = all /api/* except the open health probe (single source of truth in api-gate.ts,
  // smoke-tested). (/debug/* are gated separately.)
  const isGatedApi = isGatedApiPath(pathname);
  if (!isGatedApi) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  if (method === "OPTIONS") {
    // Gated routes get no CORS preflight; everything else keeps the 204.
    res.writeHead(isGatedApi ? 403 : 204);
    res.end();
    return;
  }

  // Central key gate: every gated /api route requires the machine key. (The handlers for the
  // former control routes also check it — harmless defense in depth.)
  if (isGatedApi && !checkControlAuth(req)) { error(res, "Unauthorized", 401); return; }

  const route = routes.find((r) => r.method === method && pathname === r.path);
  if (route) {
    try {
      await route.handler(req, res);
    } catch (e: any) {
      console.error(`Error handling ${method} ${pathname}:`, e);
      // Map known fs/process error codes so a remote caller can tell transient from permanent
      // (a blind 500 makes a file-lock look like a bad request). The code is non-sensitive.
      const code = e?.code;
      const status = code === "ENOENT" ? 404
        : (code === "EACCES" || code === "EPERM") ? 403
        : code === "EEXIST" ? 409
        : (code === "EBUSY" || code === "EMFILE") ? 503
        : 500;
      error(res, code ? `${code}: request failed` : "Internal server error", status);
    }
  } else {
    error(res, "Not found", 404);
  }
});

// Bind on all interfaces (0.0.0.0) so a remote-server proxy can reach
// this agent at the PC's LAN IP for /api/health status + API proxying. Every /api/*
// except /api/health now requires the machine key (P5b), so the LAN-exposed surface
// is key-gated; only the health probe is keyless.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Jamat agent listening on 0.0.0.0:${PORT}`);
  console.log(`Config: ${appConfig.name} (${configPath})`);
  console.log(`Categories: ${categories.map((c) => c.label).join(", ")}`);
  console.log(`Stats: ${STATS_FILE}`);
});
