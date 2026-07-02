import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendWakeOnLan } from "./wol.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// --- Config ---

// Config path resolution: REMOTE_CONFIG env (Docker / runtime mount) > --config arg > default
// next to the script. The registry holds machine keys, so in containers it is mounted at runtime
// (REMOTE_CONFIG=/config/config-remote.json) — never baked into the image.
const configIdx = process.argv.indexOf("--config");
const configPath = process.env.REMOTE_CONFIG
  ? path.resolve(process.env.REMOTE_CONFIG)
  : configIdx !== -1
    ? path.resolve(process.argv[configIdx + 1])
    : path.join(SCRIPT_DIR, "config-remote.json");

interface PcConfig {
  id: string;
  label: string;
  mac: string;
  ip: string;
  agentPort: number;
  broadcast: string;
  /** This PC's machine key (the agent's remote-control.json `token`). Injected as a Bearer on every
   *  proxied /api/* call so the dashboard works after the agent gated /api/* (plan 002 P5b). The proxy
   *  is the trusted relay that holds it; the SPA never sees it. Omit → proxied calls 401 on gated routes. */
  token?: string;
}

interface RemoteConfig {
  pcs: PcConfig[];
  server: { port: number };
}

const config: RemoteConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : config.server.port;

function findPc(id: string): PcConfig | undefined {
  return config.pcs.find(p => p.id === id);
}

function agentBase(pc: PcConfig): string {
  return `http://${pc.ip}:${pc.agentPort}`;
}

// --- Helpers ---

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function serveStatic(res: http.ServerResponse, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };

  const fullPath = path.join(SCRIPT_DIR, "web", filePath);
  if (!fullPath.startsWith(path.join(SCRIPT_DIR, "web"))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = fs.readFileSync(fullPath);
    res.writeHead(200, { "Content-Type": mimeTypes[ext] || "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function proxyToAgent(pc: PcConfig, req: http.IncomingMessage, res: http.ServerResponse, targetPath: string) {
  const agentUrl = `${agentBase(pc)}${targetPath}`;

  const proxyReq = http.request(agentUrl, {
    method: req.method,
    headers: {
      "Content-Type": req.headers["content-type"] || "application/json",
      // Inject this PC's machine key so the agent's gated /api/* (P5b) accept the proxied dashboard
      // call. /api/health needs no key, so an unconfigured token still leaves status probing working.
      ...(pc.token ? { Authorization: `Bearer ${pc.token}` } : {}),
    },
    timeout: 10000,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", () => {
    if (!res.headersSent) json(res, { error: "PC agent unreachable" }, 502);
  });

  proxyReq.on("timeout", () => {
    proxyReq.destroy();
    if (!res.headersSent) json(res, { error: "PC agent timeout" }, 504);
  });

  req.pipe(proxyReq);
}

// --- PC status check ---

function checkPcStatus(pc: PcConfig): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(`${agentBase(pc)}/api/health`, {
      method: "GET",
      timeout: 3000,
    }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost`);
  const method = req.method?.toUpperCase() ?? "GET";
  const pathname = url.pathname;

  // --- List all PCs with config (no secrets) ---
  if (method === "GET" && pathname === "/api/pcs") {
    json(res, {
      pcs: config.pcs.map(pc => ({ id: pc.id, label: pc.label })),
    });
    return;
  }

  // --- Check status of all PCs ---
  if (method === "GET" && pathname === "/api/pcs/status") {
    const results = await Promise.all(
      config.pcs.map(async (pc) => ({
        id: pc.id,
        label: pc.label,
        online: await checkPcStatus(pc),
      }))
    );
    json(res, { pcs: results });
    return;
  }

  // --- WoL for specific PC ---
  if (method === "POST" && pathname === "/api/wol") {
    const pcId = url.searchParams.get("pc");
    const pc = pcId ? findPc(pcId) : config.pcs[0];
    if (!pc) { json(res, { error: `Unknown PC: ${pcId}` }, 404); return; }
    try {
      await sendWakeOnLan(pc.mac, pc.broadcast);
      json(res, { ok: true, pc: pc.id, message: `WoL sent to ${pc.label} (${pc.mac})` });
    } catch (e: any) {
      json(res, { error: e.message }, 500);
    }
    return;
  }

  // --- PC status for specific PC ---
  if (method === "GET" && pathname === "/api/pc-status") {
    const pcId = url.searchParams.get("pc");
    const pc = pcId ? findPc(pcId) : config.pcs[0];
    if (!pc) { json(res, { error: `Unknown PC: ${pcId}` }, 404); return; }
    const online = await checkPcStatus(pc);
    json(res, { online, pc: pc.id });
    return;
  }

  // --- Per-PC API proxy: /api/pc/:pcId/* → agent /api/* ---
  const pcApiMatch = pathname.match(/^\/api\/pc\/([^/]+)(\/.*)?$/);
  if (pcApiMatch) {
    const pcId = pcApiMatch[1];
    const apiPath = pcApiMatch[2] || "/";
    const pc = findPc(pcId);
    if (!pc) { json(res, { error: `Unknown PC: ${pcId}` }, 404); return; }
    proxyToAgent(pc, req, res, "/api" + apiPath);
    return;
  }

  // --- Legacy: /api/* without PC prefix → first PC (backward compat) ---
  if (pathname.startsWith("/api/")) {
    const pc = config.pcs[0];
    if (!pc) { json(res, { error: "No PCs configured" }, 500); return; }
    proxyToAgent(pc, req, res, pathname);
    return;
  }

  // --- Static file serving ---
  if (method === "GET") {
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    serveStatic(res, file);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Claude App Remote Server listening on port ${PORT}`);
  console.log(`PCs configured: ${config.pcs.map(p => `${p.label} (${p.ip}:${p.agentPort})`).join(", ")}`);
});
