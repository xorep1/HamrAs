import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createSignalingServer } from "../src/server/signaling.mjs";

async function setup(t) {
  const signaling = createSignalingServer();
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => signaling.wss.handleUpgrade(req, socket, head, (ws) => signaling.wss.emit("connection", ws, req)));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { signaling.close(); server.close(); });
  async function peer() {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    const inbox = [];
    socket.on("message", (data) => inbox.push(JSON.parse(data.toString())));
    const next = async (type, id) => {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const index = inbox.findIndex((m) => m.type === type && (!id || m.id === id));
        if (index >= 0) return inbox.splice(index, 1)[0];
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`No ${type} message`);
    };
    const welcome = await next("welcome");
    return { socket, id: welcome.id, name: welcome.name, inbox, next, send: (data) => socket.send(JSON.stringify(data)) };
  }
  return { peer };
}
const file = { name: "report.txt", size: 42, mime: "text/plain" };

test("discovery and renaming are broadcast without trusting client IDs", async (t) => {
  const { peer } = await setup(t);
  const a = await peer();
  const b = await peer();
  b.send({ type: "join", id: a.id, name: "Phone", device: "mobile" });
  let message;
  do { message = await a.next("peers"); } while (!message.peers.some((p) => p.id === b.id && p.name === "Phone"));
  assert.equal(message.peers.find((p) => p.id === b.id).device, "mobile");
  assert.notEqual(message.peers.find((p) => p.id === a.id).name, "Phone");
});

test("consent gates signaling; strangers cannot inject into transfer", async (t) => {
  const { peer } = await setup(t);
  const [a, b, c] = [await peer(), await peer(), await peer()];
  const id = randomUUID();
  a.send({ type: "offer", id, to: b.id, file, from: c.id });
  assert.equal((await b.next("offer", id)).from, a.id);
  const data = { description: { type: "offer", sdp: "v=0" } };
  a.send({ type: "signal", id, data });
  c.send({ type: "accept", id });
  c.send({ type: "signal", id, data });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(b.inbox.filter((m) => m.type === "signal").length, 0);
  b.send({ type: "accept", id });
  await a.next("accept", id);
  a.send({ type: "signal", id, data });
  assert.deepEqual((await b.next("signal", id)).data, data);
  c.send({ type: "cancel", id });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(a.inbox.filter((m) => m.type === "cancel").length, 0);
  a.send({ type: "complete", id });
  const nextId = randomUUID();
  a.send({ type: "offer", id: nextId, to: b.id, file });
  await b.next("offer", nextId);
});

test("busy, rejection, cancellation and departure free transfer slots", async (t) => {
  const { peer } = await setup(t);
  const [a, b, c] = [await peer(), await peer(), await peer()];
  const id = randomUUID();
  a.send({ type: "offer", id, to: b.id, file });
  await b.next("offer", id);
  const blocked = randomUUID();
  c.send({ type: "offer", id: blocked, to: b.id, file });
  await c.next("error", blocked);
  b.send({ type: "reject", id });
  await a.next("reject", id);
  const second = randomUUID();
  a.send({ type: "offer", id: second, to: b.id, file });
  await b.next("offer", second);
  a.send({ type: "cancel", id: second });
  await b.next("cancel", second);
  const third = randomUUID();
  a.send({ type: "offer", id: third, to: b.id, file });
  await b.next("offer", third);
  b.socket.close();
  assert.match((await a.next("cancel", third)).reason, /قطع/);
});

test("abort frees the slot and reaches the peer as an error, not a cancel", async (t) => {
  const { peer } = await setup(t);
  const [a, b] = [await peer(), await peer()];
  const id = randomUUID();
  a.send({ type: "offer", id, to: b.id, file });
  await b.next("offer", id);
  b.send({ type: "accept", id });
  await a.next("accept", id);
  a.send({ type: "abort", id, reason: "کانال انتقال فایل با خطا مواجه شد." });
  const failure = await b.next("error", id);
  assert.equal(failure.reason, "کانال انتقال فایل با خطا مواجه شد.");
  assert.equal(b.inbox.filter((m) => m.type === "cancel").length, 0);
  const nextId = randomUUID();
  a.send({ type: "offer", id: nextId, to: b.id, file });
  await b.next("offer", nextId);
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("private chat reaches only the target, stamped with the server's identity", async (t) => {
  const { peer } = await setup(t);
  const a = await peer();
  const b = await peer();
  const c = await peer();
  a.send({ type: "join", name: "علی" });
  const id = randomUUID();

  // The sender lies about who they are and when it was sent; the server must ignore both.
  a.send({ type: "chat", id, to: b.id, text: "سلام خصوصی", from: c.id, name: "جعل", sentAt: 0 });

  const delivered = await b.next("chat", id);
  assert.equal(delivered.from, a.id);
  assert.equal(delivered.to, b.id);
  assert.equal(delivered.name, "علی");
  assert.equal(delivered.toName, b.name);
  assert.equal(delivered.text, "سلام خصوصی");
  assert.equal(delivered.id, id);
  assert.ok(delivered.sentAt > 0 && delivered.sentAt <= Date.now());

  // The confirmation carries the same envelope as the delivery; only the message type differs.
  const { type: sentType, ...sentFields } = await a.next("chat-sent", id);
  const { type: deliveredType, ...deliveredFields } = delivered;
  assert.equal(sentType, "chat-sent");
  assert.equal(deliveredType, "chat");
  assert.deepEqual({ ...sentFields, sentAt: 0 }, { ...deliveredFields, sentAt: 0 });

  // A third peer hears nothing: chat is private and never broadcast.
  await wait(30);
  assert.equal(c.inbox.filter((m) => m.type === "chat" || m.type === "chat-sent").length, 0);
  assert.equal(b.inbox.filter((m) => m.type === "chat").length, 0);
});

test("chat validation refuses bad targets and blank text without touching transfers", async (t) => {
  const { peer } = await setup(t);
  const a = await peer();
  const b = await peer();

  a.send({ type: "chat", id: randomUUID(), to: "bad-id", text: "hi" });
  assert.equal((await a.next("chat-error")).type, "chat-error");

  const selfId = randomUUID();
  a.send({ type: "chat", id: selfId, to: a.id, text: "خودم" });
  assert.match((await a.next("chat-error", selfId)).reason, /خودتان/);

  for (const text of ["", "   \n\t ", "x".repeat(4001), 42]) {
    const id = randomUUID();
    a.send({ type: "chat", id, to: b.id, text });
    assert.equal((await a.next("chat-error", id)).id, id);
  }

  await wait(30);
  // Nothing was delivered, and crucially no transfer-style error frame was produced either.
  assert.equal(b.inbox.filter((m) => m.type === "chat").length, 0);
  assert.equal(a.inbox.filter((m) => m.type === "error").length, 0);
});

test("an offline recipient is a chat error, never a transfer error", async (t) => {
  const { peer } = await setup(t);
  const a = await peer();
  const b = await peer();
  const id = randomUUID();
  a.send({ type: "chat", id, to: randomUUID(), text: "کسی آنجا نیست" });
  assert.match((await a.next("chat-error", id)).reason, /آنلاین/);
  assert.equal(a.inbox.filter((m) => m.type === "error").length, 0);

  // A peer that left is offline too, and its id must not accept a message.
  b.socket.close();
  await wait(80);
  const second = randomUUID();
  a.send({ type: "chat", id: second, to: b.id, text: "رفتی" });
  assert.equal((await a.next("chat-error", second)).id, second);
});

test("chat crosses an active transfer without disturbing it", async (t) => {
  const { peer } = await setup(t);
  const a = await peer();
  const b = await peer();
  const c = await peer();
  const transfer = randomUUID();
  a.send({ type: "offer", id: transfer, to: b.id, file });
  await b.next("offer", transfer);
  b.send({ type: "accept", id: transfer });
  await a.next("accept", transfer);

  // Both endpoints are busy with the file, yet the chat still reaches a third device.
  const chatId = randomUUID();
  a.send({ type: "chat", id: chatId, to: c.id, text: "در حین انتقال" });
  assert.equal((await c.next("chat", chatId)).text, "در حین انتقال");
  await a.next("chat-sent", chatId);

  // The transfer's own signaling is untouched by the chat frame.
  const data = { description: { type: "offer", sdp: "v=0" } };
  a.send({ type: "signal", id: transfer, data });
  assert.deepEqual((await b.next("signal", transfer)).data, data);
  b.send({ type: "signal", id: transfer, data });
  assert.deepEqual((await a.next("signal", transfer)).data, data);

  // A chat addressed to the busy peer is delivered rather than blocked the way a second offer would be.
  const direct = randomUUID();
  a.send({ type: "chat", id: direct, to: b.id, text: "به گیرندهٔ مشغول" });
  assert.equal((await b.next("chat", direct)).text, "به گیرندهٔ مشغول");
  await a.next("chat-sent", direct);

  a.send({ type: "complete", id: transfer });
  const next = randomUUID();
  a.send({ type: "offer", id: next, to: b.id, file });
  await b.next("offer", next);
});

test("a chatty peer is rate limited instead of flooding the channel", async (t) => {
  const { peer } = await setup(t);
  const a = await peer();
  const b = await peer();
  for (let index = 0; index < 35; index++) a.send({ type: "chat", id: randomUUID(), to: b.id, text: `پیام ${index}` });
  await wait(200);
  const rate = a.inbox.filter((m) => m.type === "chat-error");
  assert.ok(rate.length >= 1, "expected a rate-limit chat error");
  assert.ok(rate.every((m) => /صبر کنید/.test(m.reason)));
  // The first thirty messages still went through; the excess never reached the recipient.
  assert.equal(b.inbox.filter((m) => m.type === "chat").length, 30);
});

test("missing target, invalid metadata and binary traffic are rejected", async (t) => {
  const { peer } = await setup(t);
  const a = await peer();
  const id = randomUUID();
  a.send({ type: "offer", id, to: randomUUID(), file });
  await a.next("error", id);
  a.send({ type: "offer", id, to: a.id, file: { ...file, size: -1 } });
  await a.next("error", id);
  a.socket.send(Buffer.from([0, 1]));
  const [code] = await once(a.socket, "close");
  assert.equal(code, 1008);
});
