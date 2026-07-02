import http from "node:http";

export function sendWakeOnLan(mac: string, broadcast: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // WoL proxy URL is REQUIRED via env — no hardcoded default, so an unconfigured
    // deployment fails clearly instead of silently poking a stale LAN address.
    const proxy = process.env.WOL_PROXY_URL?.trim();
    if (!proxy) { reject(new Error("Wake-on-LAN is not configured: set WOL_PROXY_URL to your app-wol proxy (e.g. http://<host>:9009).")); return; }
    const body = JSON.stringify({ mac, broadcast });
    const url = new URL("/wol", proxy);

    const req = http.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      let data = "";
      res.on("data", (c: Buffer) => { data += c; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) resolve();
          else reject(new Error(parsed.error || "WoL proxy error"));
        } catch {
          reject(new Error(`WoL proxy bad response: ${data}`));
        }
      });
    });

    req.on("error", (e) => reject(new Error(`WoL proxy unreachable: ${e.message}`)));
    req.on("timeout", () => { req.destroy(); reject(new Error("WoL proxy timeout")); });
    req.write(body);
    req.end();
  });
}
