import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostFileStore } from "../src/server/host-files.mjs";
import { PROJECT_ROOT, loadProjectEnv, passwordRetryMilliseconds, storageDirectory, uploadPassword } from "../src/server/config.mjs";

// Only the server's clock is moved; real timers keep running.
function passwordClock(t) {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  return (milliseconds) => { now += milliseconds; };
}

// Drives one password check through the store without opening a socket.
function session(store, { password, address = "127.0.0.1" }) {
  const headers = {};
  const req = { method: "POST", socket: { remoteAddress: address }, headers: { "x-hamras-password": password } };
  const res = {
    setHeader(name, value) { headers[name] = value; },
    writeHead(status) { this.status = status; },
    end() {},
  };
  return store.handle(req, res, new URL("http://localhost/api/host/session")).then(() => ({ status: res.status, headers }));
}

test("settings are read from the file, and the process environment wins over it", async (t) => {
  const folder = await mkdtemp(path.join(tmpdir(), "hamras-config-"));
  const previous = { password: process.env.HOST_UPLOAD_PASSWORD, retry: process.env.HOST_PASSWORD_RETRY_SECONDS };
  t.after(async () => {
    for (const [key, value] of [["HOST_UPLOAD_PASSWORD", previous.password], ["HOST_PASSWORD_RETRY_SECONDS", previous.retry]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(folder, { recursive: true, force: true });
  });
  const file = path.join(folder, ".env");
  await writeFile(file, "# settings\nHOST_UPLOAD_PASSWORD=from-the-file\nHOST_PASSWORD_RETRY_SECONDS=45\nHOST_UPLOAD_DIR=data\n");

  delete process.env.HOST_UPLOAD_PASSWORD;
  process.env.HOST_PASSWORD_RETRY_SECONDS = "7";
  loadProjectEnv(file);

  assert.equal(process.env.HOST_UPLOAD_PASSWORD, "from-the-file");
  assert.equal(process.env.HOST_UPLOAD_DIR, "data");
  // A one-off launch or a process manager still overrides the file.
  assert.equal(process.env.HOST_PASSWORD_RETRY_SECONDS, "7");
});

test("a missing settings file is tolerated for environments that supply everything directly", () => {
  assert.doesNotThrow(() => loadProjectEnv(path.join(tmpdir(), "hamras-there-is-no-such-file.env")));
});

test("unusable settings are refused instead of quietly falling back", () => {
  for (const value of ["", "   ", undefined, "two\nlines"]) {
    assert.throws(() => uploadPassword(value), /HOST_UPLOAD_PASSWORD/, `password ${JSON.stringify(value)}`);
  }
  assert.equal(uploadPassword(" keep spaces "), " keep spaces ");
  assert.throws(() => storageDirectory(""), /HOST_UPLOAD_DIR/);
  assert.throws(() => storageDirectory(undefined), /HOST_UPLOAD_DIR/);
  assert.equal(storageDirectory("uploads"), path.join(PROJECT_ROOT, "uploads"));
  assert.equal(storageDirectory("data/files"), path.join(PROJECT_ROOT, "data", "files"));
  for (const value of ["", "0", "-5", "1.5", "sixty", undefined, "1e3", "0x10", "+3", "3.0"]) {
    assert.throws(() => passwordRetryMilliseconds(value), /HOST_PASSWORD_RETRY_SECONDS/, `retry ${JSON.stringify(value)}`);
  }
  assert.deepEqual(passwordRetryMilliseconds("1"), { seconds: 1, milliseconds: 1000 });
  assert.deepEqual(passwordRetryMilliseconds("300"), { seconds: 300, milliseconds: 300_000 });
  assert.deepEqual(passwordRetryMilliseconds(45), { seconds: 45, milliseconds: 45_000 });
});

test("an empty value in the environment is refused instead of replaced by a default", (t) => {
  const previous = { dir: process.env.HOST_UPLOAD_DIR, retry: process.env.HOST_PASSWORD_RETRY_SECONDS };
  t.after(() => {
    for (const [key, value] of [["HOST_UPLOAD_DIR", previous.dir], ["HOST_PASSWORD_RETRY_SECONDS", previous.retry]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.HOST_UPLOAD_DIR = "";
  assert.throws(() => createHostFileStore({ password: "test-password" }), /HOST_UPLOAD_DIR/);
  delete process.env.HOST_UPLOAD_DIR;
  // An absent value still falls back; a blank one is treated as a mistake in the settings file.
  assert.doesNotThrow(() => createHostFileStore({ password: "test-password", dir: tmpdir() }));
  process.env.HOST_PASSWORD_RETRY_SECONDS = "";
  assert.throws(() => createHostFileStore({ password: "test-password", dir: tmpdir() }), /HOST_PASSWORD_RETRY_SECONDS/);
});

test("the store cannot be created without a password", (t) => {
  const previous = process.env.HOST_UPLOAD_PASSWORD;
  t.after(() => { if (previous !== undefined) process.env.HOST_UPLOAD_PASSWORD = previous; });
  delete process.env.HOST_UPLOAD_PASSWORD;
  assert.throws(() => createHostFileStore({ dir: PROJECT_ROOT }), /HOST_UPLOAD_PASSWORD/);
});

test("the retry window the server enforces is the configured one", async (t) => {
  const advance = passwordClock(t);
  const store = createHostFileStore({ dir: path.join(tmpdir(), "hamras-unused"), password: "test-password", retrySeconds: 5 });
  const wrong = await session(store, { password: "nope" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers["Retry-After"], "5");
  const blocked = await session(store, { password: "test-password" });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers["Retry-After"], "5");
  advance(5_000);
  assert.equal((await session(store, { password: "test-password" })).status, 200);
});

test("the store honours a retry window taken from the environment", async (t) => {
  const advance = passwordClock(t);
  const previous = process.env.HOST_PASSWORD_RETRY_SECONDS;
  process.env.HOST_PASSWORD_RETRY_SECONDS = "2";
  t.after(() => {
    if (previous === undefined) delete process.env.HOST_PASSWORD_RETRY_SECONDS;
    else process.env.HOST_PASSWORD_RETRY_SECONDS = previous;
  });
  const store = createHostFileStore({ dir: path.join(tmpdir(), "hamras-unused"), password: "test-password" });
  assert.equal((await session(store, { password: "nope" })).headers["Retry-After"], "2");
  assert.equal((await session(store, { password: "test-password" })).status, 429);
  advance(2_000);
  assert.equal((await session(store, { password: "test-password" })).status, 200);
});
