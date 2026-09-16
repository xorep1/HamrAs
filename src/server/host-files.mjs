import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { HOST_UPLOAD_CHUNK, MAX_HOST_FILE_SIZE, MAX_HOST_TOTAL_SIZE, inlineViewable, safeFilename, validHostId, validHostName, validMessageText } from "../lib/protocol.mjs";
import { passwordRetryMilliseconds, storageDirectory, uploadPassword } from "./config.mjs";

// Files parked on the host, as opposed to the peer-to-peer path where nothing is ever stored.
// Writing (upload, delete) needs the password; listing, downloading and viewing never do.
//
// The host may also keep a short list of texts it wants shown on the public page. Those texts live in
// one separate, atomically-replaced JSON document beside the file library, so a reader always sees a
// complete snapshot and a crash mid-write can never leave a half-written catalogue behind.
const MESSAGE_FILE = "messages.json";
// The body of a text request is tiny; the cap is a hard stop against a client that streams garbage.
const MESSAGE_BODY_LIMIT = 32 * 1024;
// A public listing of two hundred short texts is plenty, and keeping the ceiling hard means the store
// reports "full" instead of quietly dropping whichever text happened to be oldest.
const MAX_HOST_MESSAGES = 200;
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
// The legacy filename parameter is a quoted ASCII string, so quotes and backslashes must go too;
// clients that understand filename*= use the UTF-8 form and never see this.
const asciiName = (name) => safeFilename(name).replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
// Use the socket peer, not spoofable forwarding headers. IPv4 and its mapped IPv6 form share a key.
const clientAddress = (req) => (req.socket.remoteAddress || "unknown").replace(/^::ffff:(?=\d+\.)/i, "");

export function createHostFileStore({
  dir = process.env.HOST_UPLOAD_DIR ?? "uploads",
  // No default password: a credential that ships in the code is not a credential.
  password = uploadPassword(process.env.HOST_UPLOAD_PASSWORD),
  retrySeconds = passwordRetryMilliseconds(process.env.HOST_PASSWORD_RETRY_SECONDS ?? "60").seconds,
  maxFileSize = Number(process.env.HOST_MAX_FILE_SIZE) || MAX_HOST_FILE_SIZE,
  maxTotalSize = Number(process.env.HOST_MAX_TOTAL_SIZE) || MAX_HOST_TOTAL_SIZE,
  maxMessages = Number(process.env.HOST_MAX_MESSAGES) || MAX_HOST_MESSAGES,
} = {}) {
  const { milliseconds: retryMilliseconds } = passwordRetryMilliseconds(retrySeconds);
  // Resolved against the project root so the library never depends on the launch directory.
  const root = storageDirectory(dir);
  const temp = path.join(root, ".partial");
  const secret = Buffer.from(String(password), "utf8");
  const index = new Map();
  const attempts = new Map();
  let totalBytes = 0;

  const dataPath = (id) => path.join(root, `${id}.bin`);
  const metaPath = (id) => path.join(root, `${id}.json`);
  const messagesPath = path.join(root, MESSAGE_FILE);
  const messagesTemp = path.join(root, `.${MESSAGE_FILE}.tmp`);
  let messages = [];
  // Every message mutation is a read-modify-write of the one catalogue, so they run strictly one after
  // another: the ceiling can never be overshot by two simultaneous saves, and no write overtakes another.
  let messagesChain = Promise.resolve();
  const serialise = (task) => {
    const result = messagesChain.then(task, task);
    messagesChain = result.then(() => undefined, () => undefined);
    return result;
  };
  const messageEntry = (message) => ({ id: message.id, text: message.text, createdAt: message.createdAt });
  const listMessages = () => messages.map(messageEntry);

  // Replace the document in one step: a reader either sees the previous catalogue or the new one,
  // never a truncated or partially-written file.
  async function persistMessages() {
    await writeFile(messagesTemp, JSON.stringify({ messages }));
    await rename(messagesTemp, messagesPath);
  }
  // Only well-formed records are admitted, so a hand-edited or corrupt document cannot inject a bad id
  // or a blank text into the public listing. Unknown keys are dropped rather than trusted.
  function loadMessages(raw) {
    let stored;
    try { stored = JSON.parse(raw); } catch { return []; }
    const records = Array.isArray(stored) ? stored : stored && Array.isArray(stored.messages) ? stored.messages : [];
    const seen = new Set();
    const kept = [];
    for (const record of records) {
      if (!record || typeof record !== "object") continue;
      if (!validHostId(record.id) || seen.has(record.id)) continue;
      if (!validMessageText(record.text)) continue;
      if (!Number.isSafeInteger(record.createdAt) || record.createdAt <= 0) continue;
      seen.add(record.id);
      kept.push(messageEntry(record));
    }
    kept.sort((a, b) => b.createdAt - a.createdAt);
    return kept.slice(0, maxMessages);
  }

  // One failed password locks this address for one minute across all password-protected routes.
  // Blocked retries do not check the password or extend the original deadline.
  function throttle(req) {
    const key = clientAddress(req);
    const now = Date.now();
    const until = attempts.get(key);
    if (until === undefined) return 0;
    if (until > now) return Math.ceil((until - now) / 1000);
    attempts.delete(key);
    return 0;
  }
  function record(req, ok) {
    const key = clientAddress(req);
    if (ok) { attempts.delete(key); return; }
    const now = Date.now();
    // Discard expired addresses even if those clients never return, rather than accumulating them.
    for (const [address, until] of attempts) {
      if (until <= now) attempts.delete(address);
    }
    attempts.set(key, now + retryMilliseconds);
  }
  function passwordOk(value) {
    const given = Buffer.from(typeof value === "string" ? value : "", "utf8");
    // Compare over a fixed length so the check cannot leak the password length through timing.
    const width = Math.max(given.length, secret.length, 1);
    const a = Buffer.alloc(width);
    const b = Buffer.alloc(width);
    given.copy(a);
    secret.copy(b);
    return timingSafeEqual(a, b) && given.length === secret.length;
  }
  // Authorises a writing request. Reading paths never call this.
  function authorise(req, res, supplied) {
    const wait = throttle(req);
    if (wait) {
      res.setHeader("Retry-After", String(wait));
      json(res, 429, { error: `به‌دلیل رمز اشتباه، تلاش مجدد از این IP محدود شده است؛ ${wait} ثانیه دیگر دوباره امتحان کنید.`, retryAfter: wait });
      return false;
    }
    if (!passwordOk(supplied)) {
      record(req, false);
      const retryAfter = retrySeconds;
      res.setHeader("Retry-After", String(retryAfter));
      json(res, 401, { error: `رمز آپلود درست نیست؛ ${retryAfter} ثانیه دیگر دوباره امتحان کنید.`, retryAfter });
      return false;
    }
    record(req, true);
    return true;
  }

  const entryOf = (meta) => ({ id: meta.id, name: meta.name, size: meta.size, mime: meta.mime, uploadedAt: meta.uploadedAt, viewable: inlineViewable(meta.mime) });

  async function init() {
    await mkdir(temp, { recursive: true });
    await rm(temp, { recursive: true, force: true });
    await mkdir(temp, { recursive: true });
    for (const name of await readdir(root)) {
      if (!name.endsWith(".json")) continue;
      // The chat document holds an array, not a file record, so it must never be read as one.
      if (name === MESSAGE_FILE) continue;
      try {
        const meta = JSON.parse(await readFile(path.join(root, name), "utf8"));
        if (!validHostId(meta.id) || !validHostName(meta.name)) continue;
        const size = (await stat(dataPath(meta.id))).size;
        // The file on disk wins over the recorded size, so a crash mid-upload cannot inflate the total.
        index.set(meta.id, { ...meta, size });
        totalBytes += size;
      } catch { /* An unreadable or orphaned record is skipped rather than blocking startup. */ }
    }
    try { messages = loadMessages(await readFile(messagesPath, "utf8")); }
    catch { messages = []; /* No catalogue yet, or unreadable: start empty rather than fail startup. */ }
    return { files: index.size, bytes: totalBytes, messages: messages.length };
  }

  function list() {
    return [...index.values()].sort((a, b) => b.uploadedAt - a.uploadedAt).map(entryOf);
  }
  function stats() {
    return { files: index.size, bytes: totalBytes, maxFileSize, maxTotalSize, remaining: Math.max(0, maxTotalSize - totalBytes) };
  }

  async function freeSpace() {
    try {
      const fs = await statfs(root);
      return fs.bavail * fs.bsize;
    } catch { return Infinity; }
  }

  async function upload(req, res) {
    if (!authorise(req, res, req.headers["x-hamras-password"])) return;
    let name;
    try { name = decodeURIComponent(String(req.headers["x-hamras-name"] || "")); } catch { name = ""; }
    if (!validHostName(name)) return json(res, 400, { error: "نام فایل نامعتبر است." });
    const declared = Number(req.headers["content-length"] ?? req.headers["x-hamras-size"]);
    if (!Number.isSafeInteger(declared) || declared < 0) return json(res, 411, { error: "اندازهٔ فایل مشخص نیست." });
    if (declared > maxFileSize) return json(res, 413, { error: `حداکثر اندازهٔ هر فایل ${Math.round(maxFileSize / 1024 ** 3)} گیگابایت است.` });
    if (totalBytes + declared > maxTotalSize) return json(res, 507, { error: "فضای اختصاص‌یافته روی هاست پر است؛ چند فایل را حذف کنید." });
    if (declared + 64 * 1024 * 1024 > await freeSpace()) return json(res, 507, { error: "فضای دیسک هاست کافی نیست." });

    const id = randomBytes(16).toString("hex");
    const partial = path.join(temp, `${id}.part`);
    let written = 0;
    let refused = null;
    try {
      const sink = createWriteStream(partial, { highWaterMark: HOST_UPLOAD_CHUNK });
      req.on("data", (chunk) => {
        written += chunk.length;
        // The declared length is a claim; the counter is what actually bounds the write.
        if (refused || (written <= declared && written <= maxFileSize)) return;
        refused = written > maxFileSize
          ? `حداکثر اندازهٔ هر فایل ${Math.round(maxFileSize / 1024 ** 3)} گیگابایت است.`
          : "حجم ارسالی با اندازهٔ اعلام‌شده هم‌خوانی ندارد.";
        // The answer is sent before the socket goes away: a client that is still uploading needs to
        // learn why it was cut off instead of waiting on a response that never comes.
        if (!res.headersSent) {
          res.writeHead(413, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Connection: "close" });
          res.end(JSON.stringify({ error: refused }));
        }
        req.destroy();
      });
      await pipeline(req, sink);
      if (refused) throw new Error(refused);
      if (written !== declared) throw new Error("انتقال کامل نشد؛ دوباره تلاش کنید.");
      if (totalBytes + written > maxTotalSize) throw new Error("فضای اختصاص‌یافته روی هاست پر است.");
      const meta = {
        id,
        name,
        size: written,
        mime: String(req.headers["content-type"] || "application/octet-stream").slice(0, 150),
        uploadedAt: Date.now(),
      };
      await rename(partial, dataPath(id));
      await writeFile(metaPath(id), JSON.stringify(meta));
      index.set(id, meta);
      totalBytes += written;
      json(res, 201, { file: entryOf(meta), stats: stats() });
    } catch (error) {
      await rm(partial, { force: true });
      if (res.headersSent) return;
      const message = refused || (error instanceof Error && /گیگابایت|پر است|کامل نشد|هم‌خوانی/.test(error.message) ? error.message : "");
      if (message) return json(res, refused || /پر است/.test(message) ? 413 : 400, { error: message });
      json(res, 500, { error: "ذخیرهٔ فایل روی هاست ناموفق بود." });
    }
  }

  async function download(req, res, id, inline) {
    const meta = index.get(id);
    if (!meta) return json(res, 404, { error: "این فایل روی هاست وجود ندارد." });
    const view = inline && inlineViewable(meta.mime);
    const disposition = `${view ? "inline" : "attachment"}; filename="${asciiName(meta.name)}"; filename*=UTF-8''${encodeURIComponent(meta.name)}`;
    const headers = {
      // Stored bytes are never trusted as active content: the type is only honoured for the allowlist.
      "Content-Type": view ? meta.mime : "application/octet-stream",
      "Content-Disposition": disposition,
      "Content-Security-Policy": "default-src 'none'; img-src 'self' blob:; media-src 'self' blob:; object-src 'self'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=0, must-revalidate",
      "Accept-Ranges": "bytes",
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
    let start = 0;
    let end = meta.size - 1;
    if (range && meta.size > 0) {
      const [, rawStart, rawEnd] = range;
      if (rawStart === "" && rawEnd === "") return json(res, 416, { error: "محدودهٔ درخواستی نامعتبر است." });
      if (rawStart === "") { start = Math.max(0, meta.size - Number(rawEnd)); }
      else {
        start = Number(rawStart);
        if (rawEnd !== "") end = Math.min(end, Number(rawEnd));
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= meta.size) {
        res.writeHead(416, { "Content-Range": `bytes */${meta.size}` });
        return res.end();
      }
      headers["Content-Range"] = `bytes ${start}-${end}/${meta.size}`;
    }
    const length = meta.size === 0 ? 0 : end - start + 1;
    headers["Content-Length"] = String(length);
    res.writeHead(range && meta.size > 0 ? 206 : 200, headers);
    if (req.method === "HEAD" || length === 0) return res.end();
    const source = createReadStream(dataPath(id), { start, end, highWaterMark: HOST_UPLOAD_CHUNK });
    try { await pipeline(source, res); } catch { res.destroy(); }
  }

  async function remove(req, res, id, supplied) {
    if (!authorise(req, res, supplied)) return;
    const meta = index.get(id);
    if (!meta) return json(res, 404, { error: "این فایل روی هاست وجود ندارد." });
    index.delete(id);
    totalBytes = Math.max(0, totalBytes - meta.size);
    await rm(dataPath(id), { force: true });
    await rm(metaPath(id), { force: true });
    json(res, 200, { removed: id, stats: stats() });
  }

  // Reads a small JSON body without ever buffering more than the cap: past the limit the bytes are
  // dropped and the request is answered as soon as it drains, so an oversized body cannot grow memory.
  function collectBody(req, limit) {
    return new Promise((resolve) => {
      let size = 0;
      let overflow = false;
      const chunks = [];
      req.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) { overflow = true; return; }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (overflow) return resolve({ ok: false, status: 413, error: `حداکثر حجم متن ارسالی ${Math.round(limit / 1024)} کیلوبایت است.` });
        if (!chunks.length) return resolve({ ok: false, status: 400, error: "بدنهٔ درخواست خالی است." });
        try { resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
        catch { resolve({ ok: false, status: 400, error: "بدنهٔ درخواست JSON معتبر نیست." }); }
      });
      req.on("error", () => resolve({ ok: false, status: 400, error: "خواندن بدنهٔ درخواست ناموفق بود." }));
    });
  }

  async function createMessage(req, res) {
    if (!authorise(req, res, req.headers["x-hamras-password"])) { req.resume(); return; }
    const body = await collectBody(req, MESSAGE_BODY_LIMIT);
    if (!body.ok) return json(res, body.status, { error: body.error });
    const text = body.value && typeof body.value === "object" ? body.value.text : undefined;
    if (!validMessageText(text)) return json(res, 400, { error: "متن پیام نامعتبر است." });
    const outcome = await serialise(async () => {
      // The ceiling is checked inside the serialised section, so two simultaneous saves cannot both
      // slip past it. A full store says so plainly instead of evicting an older text behind the user's back.
      if (messages.length >= maxMessages) return { full: true };
      const message = { id: randomBytes(16).toString("hex"), text, createdAt: Date.now() };
      messages.unshift(message);
      try { await persistMessages(); }
      catch (error) { messages.shift(); throw error; }
      return { message: messageEntry(message) };
    });
    if (outcome.full) return json(res, 507, { error: `ظرفیت پیام‌های هاست پر است؛ حداکثر ${maxMessages} پیام ذخیره می‌شود. چند پیام را حذف کنید.` });
    json(res, 201, { message: outcome.message });
  }

  async function deleteMessage(req, res, id, supplied) {
    if (!authorise(req, res, supplied)) { req.resume(); return; }
    const outcome = await serialise(async () => {
      const at = messages.findIndex((message) => message.id === id);
      if (at < 0) return { missing: true };
      const [removed] = messages.splice(at, 1);
      try { await persistMessages(); }
      catch (error) { messages.splice(at, 0, removed); throw error; }
      return { removed: removed.id };
    });
    if (outcome.missing) return json(res, 404, { error: "این پیام روی هاست وجود ندارد." });
    json(res, 200, { removed: outcome.removed });
  }

  // Returns true when the request belonged to this feature and a response was produced.
  async function handle(req, res, url) {
    const route = url.pathname.replace(/\/+$/, "");
    const messagesRoute = route === "/api/host/messages" || route.startsWith("/api/host/messages/");
    if (route !== "/api/host/files" && !route.startsWith("/api/host/files/") && route !== "/api/host/session" && !messagesRoute) return false;
    // Host texts: adding and deleting are password-gated, listing is open to the LAN and read-only.
    if (route === "/api/host/messages") {
      if (req.method === "GET") json(res, 200, { messages: listMessages() });
      else if (req.method === "POST") await createMessage(req, res);
      else json(res, 405, { error: "روش درخواست پشتیبانی نمی‌شود." });
      return true;
    }
    if (messagesRoute) {
      const messageId = route.slice("/api/host/messages/".length);
      if (!validHostId(messageId)) { json(res, 400, { error: "شناسهٔ پیام نامعتبر است." }); return true; }
      if (req.method === "DELETE") await deleteMessage(req, res, messageId, req.headers["x-hamras-password"]);
      else json(res, 405, { error: "روش درخواست پشتیبانی نمی‌شود." });
      return true;
    }
    if (route === "/api/host/session") {
      if (req.method !== "POST") { json(res, 405, { error: "روش درخواست پشتیبانی نمی‌شود." }); return true; }
      if (authorise(req, res, req.headers["x-hamras-password"])) json(res, 200, { ok: true, stats: stats() });
      return true;
    }
    if (route === "/api/host/files") {
      if (req.method === "GET") json(res, 200, { files: list(), stats: stats() });
      else if (req.method === "POST") await upload(req, res);
      else json(res, 405, { error: "روش درخواست پشتیبانی نمی‌شود." });
      return true;
    }
    const id = route.slice("/api/host/files/".length);
    if (!validHostId(id)) { json(res, 400, { error: "شناسهٔ فایل نامعتبر است." }); return true; }
    if (req.method === "GET" || req.method === "HEAD") await download(req, res, id, url.searchParams.get("inline") === "1");
    else if (req.method === "DELETE") await remove(req, res, id, req.headers["x-hamras-password"]);
    else json(res, 405, { error: "روش درخواست پشتیبانی نمی‌شود." });
    return true;
  }

  return { init, handle, list, stats, listMessages, root };
}
