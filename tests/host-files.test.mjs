import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostFileStore } from "../src/server/host-files.mjs";

// A fixture password: the real one lives in .env and is passed in explicitly by the tests.
const PASSWORD = "test-password";

// Only advance the server's password clock; HTTP timers still run normally.
function passwordClock(t) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  return (milliseconds) => { now += milliseconds; };
}

// A request that bypasses fetch()'s URL normalisation and its refusal to over-declare a body.
function raw(base, { method, path: target, headers = {}, body, localAddress }) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const request = http.request({ host: url.hostname, port: url.port, method, path: target, headers, localAddress }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
    });
    request.on("error", (error) => reject(error));
    request.setTimeout(8000, () => { request.destroy(new Error("raw request timed out")); });
    if (body) request.write(body);
    request.end();
  });
}

async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "hamras-host-"));
  const store = createHostFileStore({ dir, password: PASSWORD, ...options });
  await store.init();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    store.handle(req, res, url).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

  const put = (body, { name = "file.bin", password = PASSWORD, type = "application/octet-stream", size } = {}) =>
    fetch(`${base}/api/host/files`, {
      method: "POST",
      headers: {
        "x-hamras-password": password,
        "x-hamras-name": encodeURIComponent(name),
        "content-type": type,
        "content-length": String(size ?? body.length),
      },
      body,
      duplex: "half",
    });
  const post = (text, { password = PASSWORD } = {}) =>
    fetch(`${base}/api/host/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hamras-password": password },
      body: JSON.stringify({ text }),
    });
  return { base, store, dir, put, post };
}

test("upload needs the password, listing and download never do", async (t) => {
  const advance = passwordClock(t);
  const { base, put } = await setup(t);
  const data = Buffer.from("محتوای آزمایشی روی هاست");

  const wrong = await put(data, { password: "0000" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("retry-after"), "60");
  advance(60_000);
  const missing = await put(data, { password: "" });
  assert.equal(missing.status, 401);
  assert.deepEqual((await (await fetch(`${base}/api/host/files`)).json()).files, []);
  assert.equal((await put(data)).status, 429);
  advance(60_000);

  const created = await put(data, { name: "گزارش نهایی.txt", type: "text/plain" });
  assert.equal(created.status, 201);
  const { file } = await created.json();
  assert.equal(file.name, "گزارش نهایی.txt");
  assert.equal(file.size, data.length);
  assert.equal(file.viewable, true);

  // No credentials on any read path.
  const listed = await fetch(`${base}/api/host/files`);
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).files.length, 1);

  const got = await fetch(`${base}/api/host/files/${file.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "application/octet-stream");
  assert.match(got.headers.get("content-disposition"), /^attachment;/);
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), data);
});

test("only allowlisted types may render inline, and never as active content", async (t) => {
  const { base, put } = await setup(t);
  const page = Buffer.from("<script>alert(1)</script>");
  const { file: html } = await (await put(page, { name: "evil.html", type: "text/html" })).json();
  const served = await fetch(`${base}/api/host/files/${html.id}?inline=1`);
  // An uploaded page is forced back to a download, so it can never run on this origin.
  assert.equal(served.headers.get("content-type"), "application/octet-stream");
  assert.match(served.headers.get("content-disposition"), /^attachment;/);
  assert.match(served.headers.get("content-security-policy"), /sandbox/);
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");

  const { file: image } = await (await put(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { name: "shot.png", type: "image/png" })).json();
  const inline = await fetch(`${base}/api/host/files/${image.id}?inline=1`);
  assert.equal(inline.headers.get("content-type"), "image/png");
  assert.match(inline.headers.get("content-disposition"), /^inline;/);
});

test("range requests serve partial content so media can seek", async (t) => {
  const { base, put } = await setup(t);
  const data = Buffer.from("0123456789");
  const { file } = await (await put(data, { name: "clip.mp4", type: "video/mp4" })).json();

  const part = await fetch(`${base}/api/host/files/${file.id}`, { headers: { range: "bytes=2-5" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 2-5/10`);
  assert.equal(await part.text(), "2345");

  const tail = await fetch(`${base}/api/host/files/${file.id}`, { headers: { range: "bytes=-3" } });
  assert.equal(await tail.text(), "789");

  const head = await fetch(`${base}/api/host/files/${file.id}`, { method: "HEAD" });
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(head.headers.get("accept-ranges"), "bytes");

  const bad = await fetch(`${base}/api/host/files/${file.id}`, { headers: { range: "bytes=99-200" } });
  assert.equal(bad.status, 416);
});

test("size limits are enforced against the real byte count, not the claim", async (t) => {
  const { base, put } = await setup(t, { maxFileSize: 1024 });
  const over = await put(Buffer.alloc(2048), { name: "big.bin" });
  assert.equal(over.status, 413);

  // With no content-length the size is only a claim in a header, so the byte counter has to be what
  // actually stops the write. The client must also learn why, not just lose the socket.
  const lying = await raw(base, {
    method: "POST", path: "/api/host/files",
    headers: { "x-hamras-password": PASSWORD, "x-hamras-name": "liar.bin", "transfer-encoding": "chunked", "x-hamras-size": "10" },
    body: Buffer.alloc(4096),
  });
  assert.equal(lying.status, 413);
  assert.match(lying.body, /هم‌خوانی|گیگابایت/);

  // A body that stops short of the declared length is incomplete and must not be kept either.
  const short = await raw(base, {
    method: "POST", path: "/api/host/files",
    headers: { "x-hamras-password": PASSWORD, "x-hamras-name": "short.bin", "transfer-encoding": "chunked", "x-hamras-size": "900" },
    body: Buffer.alloc(100),
  });
  assert.equal(short.status, 400);
  assert.deepEqual((await (await fetch(`${base}/api/host/files`)).json()).files, []);
});

test("the library ceiling refuses uploads once full", async (t) => {
  const { base, put } = await setup(t, { maxTotalSize: 1000 });
  assert.equal((await put(Buffer.alloc(600), { name: "a.bin" })).status, 201);
  const full = await put(Buffer.alloc(600), { name: "b.bin" });
  assert.equal(full.status, 507);
  const { stats } = await (await fetch(`${base}/api/host/files`)).json();
  assert.equal(stats.bytes, 600);
  assert.equal(stats.remaining, 400);
});

test("invalid names, ids and methods are refused", async (t) => {
  const { base, put } = await setup(t);
  assert.equal((await put(Buffer.from("x"), { name: "" })).status, 400);
  assert.equal((await put(Buffer.from("x"), { name: "a".repeat(300) })).status, 400);
  // fetch() normalises dot segments, so traversal is probed with a raw, unnormalised request line.
  for (const target of ["/api/host/files/../../server.mjs", "/api/host/files/..%2f..%2fserver.mjs", "/api/host/files/%2e%2e%2fetc%2fpasswd"]) {
    const attempt = await raw(base, { method: "GET", path: target });
    assert.ok([400, 404].includes(attempt.status), `${target} -> ${attempt.status}`);
    assert.ok(!attempt.body.includes("createSignalingServer"), `${target} leaked a file`);
  }
  assert.equal((await fetch(`${base}/api/host/files/notanid`)).status, 400);
  assert.equal((await fetch(`${base}/api/host/files/${"a".repeat(32)}`)).status, 404);
  assert.equal((await fetch(`${base}/api/host/files`, { method: "PUT" })).status, 405);
});

test("one failed password locks every writing route but leaves reads open", async (t) => {
  const advance = passwordClock(t);
  const { base, put, post } = await setup(t);
  const { file } = await (await put(Buffer.from("bye"), { name: "gone.bin" })).json();
  const { message } = await (await post("متن عمومی")).json();
  const unauthorised = await fetch(`${base}/api/host/files/${file.id}`, { method: "DELETE" });
  assert.equal(unauthorised.status, 401);
  assert.equal(unauthorised.headers.get("retry-after"), "60");
  assert.equal((await unauthorised.json()).retryAfter, 60);

  for (const [method, route] of [
    ["POST", "/api/host/session"], ["POST", "/api/host/files"],
    ["DELETE", `/api/host/files/${file.id}`], ["POST", "/api/host/messages"],
    ["DELETE", `/api/host/messages/${message.id}`],
  ]) {
    const response = await fetch(`${base}${route}`, { method, headers: { "x-hamras-password": PASSWORD } });
    assert.equal(response.status, 429, `${method} ${route}`);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal((await response.json()).retryAfter, 60);
  }
  assert.equal((await (await fetch(`${base}/api/host/files`)).json()).files.length, 1);
  assert.equal((await (await fetch(`${base}/api/host/messages`)).json()).messages.length, 1);
  assert.equal(await (await fetch(`${base}/api/host/files/${file.id}`)).text(), "bye");
  assert.equal((await fetch(`${base}/api/host/files/${file.id}`, { method: "HEAD" })).status, 200);
  advance(60_000);
  assert.equal((await fetch(`${base}/api/host/files/${file.id}`, { method: "DELETE", headers: { "x-hamras-password": PASSWORD } })).status, 200);
});

test("the cooldown expires at exactly 60 seconds and retries cannot extend it", async (t) => {
  const advance = passwordClock(t);
  const { base } = await setup(t);
  const check = (password) => fetch(`${base}/api/host/session`, { method: "POST", headers: { "x-hamras-password": password } });
  // Successful attempts never start a cooldown.
  assert.equal((await check(PASSWORD)).status, 200);
  assert.equal((await check(PASSWORD)).status, 200);
  assert.equal((await check("wrong")).status, 401);
  advance(1001);
  let blocked = await check("another guess");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "59");
  advance(58_998);
  blocked = await check(PASSWORD);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("retry-after"), "1");
  assert.equal((await blocked.json()).retryAfter, 1);
  advance(1);
  const accepted = await check(PASSWORD);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.headers.get("retry-after"), null);
  assert.equal((await check("wrong again")).status, 401);
  assert.equal((await check(PASSWORD)).status, 429);
  advance(60_000);
  assert.equal((await check(PASSWORD)).status, 200);
});

test("concurrent guesses share the same one-minute lock", async (t) => {
  passwordClock(t);
  const { base } = await setup(t);
  const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(`${base}/api/host/session`, {
    method: "POST", headers: { "x-hamras-password": "wrong" },
  })));
  assert.equal(responses.filter((response) => response.status === 401).length, 1);
  assert.equal(responses.filter((response) => response.status === 429).length, 7);
  for (const response of responses) assert.equal((await response.json()).retryAfter, 60);
});

test("locks are per socket IP and forwarding headers cannot bypass them", async (t) => {
  passwordClock(t);
  const { base } = await setup(t);
  const check = (localAddress, password, extraHeaders = {}) => raw(base, {
    method: "POST", path: "/api/host/session", localAddress,
    headers: { "x-hamras-password": password, ...extraHeaders },
  });
  assert.equal((await check("127.0.0.1", "wrong")).status, 401);
  assert.equal((await check("127.0.0.2", PASSWORD)).status, 200);
  assert.equal((await check("127.0.0.1", PASSWORD, {
    "x-forwarded-for": "127.0.0.3", "x-real-ip": "127.0.0.3", forwarded: "for=127.0.0.3",
  })).status, 429);
  assert.equal((await check("127.0.0.2", "wrong")).status, 401);
  assert.equal((await check("127.0.0.2", PASSWORD)).status, 429);
});

test("IPv4 and IPv4-mapped IPv6 forms share one cooldown", async (t) => {
  passwordClock(t);
  const store = createHostFileStore({ password: PASSWORD });
  async function check(address, password) {
    const req = { method: "POST", socket: { remoteAddress: address }, headers: { "x-hamras-password": password } };
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end() {} };
    await store.handle(req, res, new URL("http://localhost/api/host/session"));
    return res.status;
  }
  assert.equal(await check("127.0.0.1", "wrong"), 401);
  assert.equal(await check("::ffff:127.0.0.1", PASSWORD), 429);
  assert.equal(await check("::1", PASSWORD), 200);
  assert.equal(await check("::1", "wrong"), 401);
  assert.equal(await check("::1", PASSWORD), 429);
});

test("stored files and their sizes survive a restart", async (t) => {
  const { base, put, dir } = await setup(t);
  await (await put(Buffer.alloc(4096), { name: "kept.bin" })).json();
  await writeFile(path.join(dir, "orphan.json"), "{not json");

  const reopened = createHostFileStore({ dir, password: PASSWORD });
  const summary = await reopened.init();
  assert.equal(summary.files, 1);
  assert.equal(summary.bytes, 4096);
  assert.equal(reopened.list()[0].name, "kept.bin");
  assert.ok(base);
});

test("host texts need the password to add while the listing stays public", async (t) => {
  const advance = passwordClock(t);
  const { base, post } = await setup(t);
  assert.deepEqual((await (await fetch(`${base}/api/host/messages`)).json()).messages, []);

  assert.equal((await post("سلام", { password: "0000" })).status, 401);
  advance(60_000);
  assert.equal((await post("سلام", { password: "" })).status, 401);
  assert.equal((await post("سلام", { password: PASSWORD })).status, 429);
  assert.equal((await (await fetch(`${base}/api/host/messages`)).json()).messages.length, 0);
  advance(60_000);

  const created = await post("سلام دنیا");
  assert.equal(created.status, 201);
  const { message } = await created.json();
  assert.match(message.id, /^[0-9a-f]{32}$/);
  assert.equal(message.text, "سلام دنیا");
  assert.ok(Number.isSafeInteger(message.createdAt) && message.createdAt > 0);

  const listed = await fetch(`${base}/api/host/messages`);
  assert.equal(listed.status, 200);
  assert.match(listed.headers.get("content-type"), /application\/json/);
  assert.equal(listed.headers.get("cache-control"), "no-store");
  assert.deepEqual((await listed.json()).messages, [message]);
});

test("the public listing is newest first and deletion needs the password", async (t) => {
  const { base, post } = await setup(t);
  const first = (await (await post("اول")).json()).message;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = (await (await post("دوم")).json()).message;
  let { messages } = await (await fetch(`${base}/api/host/messages`)).json();
  assert.deepEqual(messages.map((m) => m.id), [second.id, first.id]);

  const advance = passwordClock(t);
  assert.equal((await fetch(`${base}/api/host/messages/${first.id}`, { method: "DELETE" })).status, 401);
  advance(60_000);
  assert.equal((await fetch(`${base}/api/host/messages/${first.id}`, { method: "DELETE", headers: { "x-hamras-password": "0000" } })).status, 401);
  advance(60_000);
  const removed = await fetch(`${base}/api/host/messages/${first.id}`, { method: "DELETE", headers: { "x-hamras-password": PASSWORD } });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { removed: first.id });
  ({ messages } = await (await fetch(`${base}/api/host/messages`)).json());
  assert.deepEqual(messages.map((m) => m.id), [second.id]);

  // Unknown ids, malformed ids and unsupported methods are all refused.
  assert.equal((await fetch(`${base}/api/host/messages/${"a".repeat(32)}`, { method: "DELETE", headers: { "x-hamras-password": PASSWORD } })).status, 404);
  assert.equal((await fetch(`${base}/api/host/messages/notanid`, { method: "DELETE", headers: { "x-hamras-password": PASSWORD } })).status, 400);
  assert.equal((await fetch(`${base}/api/host/messages`, { method: "PUT", headers: { "x-hamras-password": PASSWORD } })).status, 405);
  assert.equal((await fetch(`${base}/api/host/messages/${second.id}`, { method: "POST", headers: { "x-hamras-password": PASSWORD } })).status, 405);
});

test("Persian, multiline and HTML text survives a save/load round trip byte for byte", async (t) => {
  const { base, post, dir } = await setup(t);
  const exact = "سلام دوست من 🇮🇷\nخط دوم با فاصله    \r\n<b>پررنگ</b> & \"نقل قول\" <script>alert(1)</script>\n\n\tپایان  ";
  const { message } = await (await post(exact)).json();
  assert.equal((await (await fetch(`${base}/api/host/messages`)).json()).messages[0].text, exact);
  // The document on disk holds the same bytes, so a restart can only reproduce the exact text.
  const reopened = createHostFileStore({ dir, password: PASSWORD });
  await reopened.init();
  assert.equal(reopened.listMessages()[0].text, exact);
  assert.equal(reopened.listMessages()[0].id, message.id);
});

test("text input is bounded on every axis", async (t) => {
  const { base, post } = await setup(t);
  assert.equal((await post("")).status, 400);
  assert.equal((await post("   \n\t ")).status, 400);
  assert.equal((await post("x".repeat(4001))).status, 400);
  assert.equal((await post(undefined)).status, 400);
  const advance = passwordClock(t);
  assert.equal((await post("متن", { password: "nope" })).status, 401);
  advance(60_000);

  // A body larger than the 32 KiB cap is refused before it is parsed, whatever the text would have been.
  const huge = await raw(base, {
    method: "POST", path: "/api/host/messages",
    headers: { "content-type": "application/json", "x-hamras-password": PASSWORD },
    body: JSON.stringify({ text: "a".repeat(40 * 1024) }),
  });
  assert.equal(huge.status, 413);
  const bad = await raw(base, { method: "POST", path: "/api/host/messages", headers: { "content-type": "application/json", "x-hamras-password": PASSWORD }, body: "not json" });
  assert.equal(bad.status, 400);
  assert.deepEqual((await (await fetch(`${base}/api/host/messages`)).json()).messages, []);
});

test("the saved-text ceiling is reported instead of evicting older texts", async (t) => {
  const { base, post } = await setup(t, { maxMessages: 3 });
  for (let index = 0; index < 3; index++) assert.equal((await post(`متن ${index}`)).status, 201);
  const full = await post("یکی بیشتر");
  assert.equal(full.status, 507);
  assert.match((await full.json()).error, /پر است/);
  const { messages } = await (await fetch(`${base}/api/host/messages`)).json();
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((m) => m.text).sort(), ["متن 0", "متن 1", "متن 2"].sort());
});

test("concurrent saves are serialised and never exceed the ceiling", async (t) => {
  const { base, post, dir } = await setup(t, { maxMessages: 20 });
  const responses = await Promise.all(Array.from({ length: 40 }, (_, index) => post(`پیام ${index}`)));
  assert.equal(responses.filter((response) => response.status === 201).length, 20);
  assert.equal(responses.filter((response) => response.status === 507).length, 20);
  const { messages } = await (await fetch(`${base}/api/host/messages`)).json();
  assert.equal(messages.length, 20);
  assert.equal(new Set(messages.map((message) => message.id)).size, 20);
  // The persisted document matches memory, so a restart loads the same twenty.
  const reopened = createHostFileStore({ dir, password: PASSWORD });
  const summary = await reopened.init();
  assert.equal(summary.messages, 20);
  assert.equal(reopened.listMessages().length, 20);
});

test("host texts persist across a restart without being confused for files", async (t) => {
  const { dir, post, put } = await setup(t);
  await (await put(Buffer.alloc(16), { name: "kept.bin" })).json();
  const { message } = await (await post("متن ماندگار")).json();
  const reopened = createHostFileStore({ dir, password: PASSWORD });
  const summary = await reopened.init();
  assert.equal(summary.files, 1);
  assert.equal(summary.messages, 1);
  assert.equal(reopened.list()[0].name, "kept.bin");
  assert.deepEqual(reopened.listMessages(), [{ id: message.id, text: "متن ماندگار", createdAt: message.createdAt }]);
});
