import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { networkInterfaces } from "node:os";
import next from "next";
import { createSignalingServer } from "./src/server/signaling.mjs";
import { createHostFileStore } from "./src/server/host-files.mjs";
import { isPrivateAddress } from "./src/lib/protocol.mjs";
import { loadProjectEnv, tlsFiles } from "./src/server/config.mjs";

// Every setting comes from .env at the project root: allowed domain names, upload password,
// password-attempt limit and the storage folder. Anything already in the process environment wins.
loadProjectEnv();

const dev = !process.argv.includes("--production");
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || "0.0.0.0";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const addresses = Object.values(networkInterfaces()).flat().filter(Boolean).map((item) => item.address);
// These names are always accepted; the domains that belong to the deployment come from LAN_HOSTS in .env.
const allowedHosts = new Set(["localhost", "127.0.0.1", "[::1]", ...addresses.flatMap((ip) => [ip, `[${ip}]`])]);
for (const host of (process.env.LAN_HOSTS || "").split(",").filter(Boolean)) allowedHosts.add(host.trim().toLowerCase());
// Optional open mode: the LAN-only guard is a safety default, not a requirement. Set ALLOW_ALL=1 to
// accept every Host header and every source address, for example when a forwarding proxy sits in front.
const openAccess = !["", "0", "false", "no"].includes((process.env.ALLOW_ALL || "").toLowerCase());
// Optional TLS: a LAN address is not a secure context, and direct-to-disk saving needs one.
const { certFile, keyFile, secure } = tlsFiles(process.env.TLS_CERT_FILE, process.env.TLS_KEY_FILE);
const app = next({ dev, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
const upgrade = app.getUpgradeHandler();
const signaling = createSignalingServer();
// Host storage: files parked on this machine. Uploading needs a password, reading them never does.
const hostFiles = createHostFileStore();
const stored = await hostFiles.init();

function blocked(req, reason) {
  console.log(`[blocked] ${req.method || "upgrade"} host=${req.headers.host} remote=${req.socket.remoteAddress} reason=${reason}`);
}
function allowed(req) {
  if (openAccess) return true;
  try {
    const host = new URL(`http://${req.headers.host}`).hostname.toLowerCase();
    const knownHost = allowedHosts.has(host);
    if (knownHost && isPrivateAddress(req.socket.remoteAddress)) return true;
    blocked(req, knownHost ? "address-not-private" : "host-not-allowed");
    return false;
  } catch {
    blocked(req, "unparsable-host");
    return false;
  }
}
const server = (secure
  ? https.createServer({ cert: readFileSync(certFile), key: readFileSync(keyFile) }, handler)
  : http.createServer(handler));
function handler(req, res) {
  if (!allowed(req)) { res.writeHead(403); res.end("Local network access only"); return; }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  let url;
  try { url = new URL(req.url, `http://${req.headers.host}`); } catch { res.writeHead(400); res.end("Bad request"); return; }
  // The host-file routes stream straight to and from disk, bypassing the framework entirely: a 4 GiB
  // body must never be buffered by a route handler.
  if (url.pathname.startsWith("/api/host/")) {
    hostFiles.handle(req, res, url)
      .then((handled) => {
        // An /api/host/ route the store does not own still has to be answered, or the request hangs.
        if (handled || res.headersSent) return;
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "مسیر درخواستی روی هاست وجود ندارد." }));
      })
      .catch(() => {
        if (!res.headersSent) { res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify({ error: "خطای غیرمنتظره روی هاست." })); }
        else res.destroy();
      });
    return;
  }
  handle(req, res);
}
server.on("upgrade", (req, socket, head) => {
  if (!allowed(req)) return socket.destroy();
  let url;
  try { url = new URL(req.url, `http://${req.headers.host}`); } catch { return socket.destroy(); }
  if (url.pathname === "/signal") {
    let origin;
    try { origin = new URL(req.headers.origin); } catch { return socket.destroy(); }
    if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host) return socket.destroy();
    signaling.wss.handleUpgrade(req, socket, head, (ws) => signaling.wss.emit("connection", ws, req));
  } else if (dev && url.pathname.startsWith("/_next/")) {
    upgrade(req, socket, head);
  } else socket.destroy();
});
server.listen(port, hostname, () => {
  const scheme = secure ? "https" : "http";
  console.log(`Hamras ready: ${scheme}://localhost:${port}`);
  for (const ip of addresses.filter((ip) => ip.includes(".") && !ip.startsWith("127."))) {
    console.log(`LAN: ${scheme}://${ip}:${port}`);
  }
  if (secure) console.log("Accept the certificate on each device; direct-to-disk saving needs a trusted secure context.");
  else console.log("Direct-to-disk saving needs HTTPS or localhost; see TLS_CERT_FILE and TLS_KEY_FILE.");
  if (openAccess) console.log("WARNING: ALLOW_ALL is set - every host and address is accepted, including anything that can reach this port.");
  else console.log("Only local addresses and this machine's own host names are accepted; set ALLOW_ALL=1 to disable that guard.");
  console.log(`Host storage: ${hostFiles.root} (${stored.files} file(s), ${(stored.bytes / 1024 ** 3).toFixed(2)} GiB). Uploads need the password; downloads do not.`);
  console.log("Use this address on devices on the same trusted LAN. Do not expose this server to the internet.");
});
function shutdown() {
  signaling.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
