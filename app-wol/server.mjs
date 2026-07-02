import http from "node:http";
import dgram from "node:dgram";

const PORT = 9009;

function sendWol(mac, broadcast = "255.255.255.255") {
  return new Promise((resolve, reject) => {
    const macBytes = Buffer.from(mac.replace(/[:-]/g, ""), "hex");
    if (macBytes.length !== 6) return reject(new Error("Invalid MAC"));

    const magic = Buffer.alloc(102);
    magic.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) macBytes.copy(magic, 6 + i * 6);

    const sock = dgram.createSocket("udp4");
    sock.once("listening", () => {
      sock.setBroadcast(true);
      sock.send(magic, 0, 102, 9, broadcast, (err) => {
        sock.close();
        err ? reject(err) : resolve();
      });
    });
    sock.on("error", (err) => { sock.close(); reject(err); });
    sock.bind();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/wol") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", async () => {
      try {
        const { mac, broadcast } = JSON.parse(body || "{}");
        if (!mac) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "mac required" }));
          return;
        }
        await sendWol(mac, broadcast || "255.255.255.255");
        console.log(`WoL sent to ${mac}`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, mac }));
      } catch (e) {
        console.error("WoL error:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const testIdx = process.argv.indexOf("--test");
if (testIdx !== -1) {
  const mac = process.argv[testIdx + 1];
  const broadcast = process.argv[testIdx + 2] || "255.255.255.255";
  if (!mac) { console.error("Usage: node server.mjs --test <MAC> [broadcast]"); process.exit(1); }
  sendWol(mac, broadcast).then(() => { console.log(`WoL sent to ${mac} (broadcast: ${broadcast})`); }).catch((e) => { console.error("Error:", e.message); process.exit(1); });
} else {
  server.listen(PORT, () => {
    console.log(`WoL Proxy listening on port ${PORT}`);
  });
}
