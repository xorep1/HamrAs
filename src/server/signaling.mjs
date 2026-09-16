import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { cleanName, HEARTBEAT_INTERVAL, OFFER_TIMEOUT, validFile, validId, validMessageText, validSignal } from "../lib/protocol.mjs";

// Chat rides the same socket as transfers but is deliberately independent of them: a private message
// is relayed even while a file transfer is running, and it is never queued, stored or acknowledged.
// The rate cap is a modest per-peer ceiling so a chatty client cannot drown the signaling channel.
const CHAT_WINDOW = 10_000;
const CHAT_MAX = 30;

export function createSignalingServer() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024, perMessageDeflate: false });
  const peers = new Map();
  const transfers = new Map();
  // Returns true only when the frame was actually handed to an open socket, so the caller can tell a
  // relay that happened from one that could not be delivered.
  const send = (peer, data) => {
    if (peer?.socket.readyState === WebSocket.OPEN) {
      if (peer.socket.bufferedAmount > 256 * 1024) peer.socket.terminate();
      else { peer.socket.send(JSON.stringify(data)); return true; }
    }
    return false;
  };
  const broadcastPeers = () => {
    const list = [...peers.values()].map(({ id, name, device }) => ({ id, name, device }));
    for (const peer of peers.values()) send(peer, { type: "peers", peers: list });
  };
  const finish = (transfer, type, reason) => {
    clearTimeout(transfer.timer);
    transfers.delete(transfer.id);
    for (const id of [transfer.from, transfer.to]) {
      send(peers.get(id), { type, id: transfer.id, reason });
    }
  };
  const busy = (id) => [...transfers.values()].some((t) => t.from === id || t.to === id);

  wss.on("connection", (socket) => {
    if (peers.size >= 64) return socket.close(1013, "Room full");
    const id = randomUUID();
    const peer = { id, socket, name: `Device-${id.slice(0, 4)}`, device: "desktop", alive: true, window: Date.now(), messages: 0, chatWindow: 0, chatCount: 0 };
    peers.set(id, peer);
    send(peer, { type: "welcome", id, name: peer.name });
    broadcastPeers();
    socket.on("pong", () => { peer.alive = true; });
    socket.on("error", () => socket.terminate());
    socket.on("message", (raw, binary) => {
      if (Date.now() - peer.window > 1000) { peer.window = Date.now(); peer.messages = 0; }
      if (++peer.messages > 100 || binary) return socket.close(1008, "Invalid signaling traffic");
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return socket.close(1008, "Invalid JSON"); }
      if (!message || typeof message !== "object") return;
      const error = (reason) => send(peer, { type: "error", id: validId(message.id) ? message.id : undefined, reason });
      // Chat has its own error channel so a bad message can never be mistaken for a transfer failure.
      const chatError = (reason) => send(peer, { type: "chat-error", id: validId(message.id) ? message.id : undefined, reason });
      if (message.type === "join") {
        peer.name = cleanName(message.name) || peer.name;
        peer.device = message.device === "mobile" ? "mobile" : "desktop";
        broadcastPeers();
        return;
      }
      // Private text is handled before any transfer bookkeeping, so it is relayed even while this
      // peer or the target is busy with a file, and it never creates, joins or cancels a transfer.
      if (message.type === "chat") {
        if (!validId(message.id) || !validId(message.to)) return chatError("درخواست نامعتبر است.");
        if (message.to === id) return chatError("فرستادن پیام به خودتان ممکن نیست.");
        const now = Date.now();
        if (now - peer.chatWindow > CHAT_WINDOW) { peer.chatWindow = now; peer.chatCount = 0; }
        if (++peer.chatCount > CHAT_MAX) return chatError("تعداد پیام‌های ارسالی زیاد بود؛ کمی صبر کنید.");
        if (!validMessageText(message.text)) return chatError("متن پیام نامعتبر است.");
        const target = peers.get(message.to);
        if (!target || target.socket.readyState !== WebSocket.OPEN) return chatError("گیرنده دیگر آنلاین نیست.");
        // Identity and time are minted here: a client's claimed sender or timestamp is never trusted.
        const envelope = {
          id: message.id,
          from: id,
          name: peer.name,
          to: target.id,
          toName: target.name,
          text: message.text,
          sentAt: now,
        };
        // The sender hears "sent" only once the frame reached the open recipient socket; this is a
        // relay confirmation, not a read receipt, and nothing is logged or replayed.
        if (send(target, { type: "chat", ...envelope })) send(peer, { type: "chat-sent", ...envelope });
        else chatError("گیرنده دیگر آنلاین نیست.");
        return;
      }
      if (!validId(message.id)) return error("درخواست نامعتبر است.");
      if (message.type === "offer") {
        if (!validFile(message.file) || !validId(message.to) || message.to === id) return error("فایل یا گیرنده نامعتبر است.");
        if (!peers.has(message.to)) return error("گیرنده دیگر آنلاین نیست.");
        if (transfers.has(message.id) || busy(id) || busy(message.to)) return error("یکی از دستگاه‌ها انتقال فعال دارد؛ دوباره تلاش کنید.");
        const transfer = { id: message.id, from: id, to: message.to, accepted: false, timer: null };
        transfer.timer = setTimeout(() => finish(transfer, "cancel", "زمان تأیید دریافت تمام شد."), OFFER_TIMEOUT);
        transfers.set(transfer.id, transfer);
        send(peers.get(transfer.to), { type: "offer", id: transfer.id, from: id, name: peer.name, file: message.file });
        return;
      }
      const transfer = transfers.get(message.id);
      if (!transfer || (transfer.from !== id && transfer.to !== id)) return;
      if (message.type === "accept" && transfer.to === id && !transfer.accepted) {
        transfer.accepted = true;
        clearTimeout(transfer.timer);
        // A bounded lifetime cleans up abandoned signaling sessions even if a tab sleeps.
        transfer.timer = setTimeout(() => finish(transfer, "cancel", "زمان نشست انتقال تمام شد."), 30 * 60_000);
        send(peers.get(transfer.from), { type: "accept", id: transfer.id });
      } else if (message.type === "reject" && transfer.to === id && !transfer.accepted) {
        finish(transfer, "reject", "گیرنده درخواست را نپذیرفت.");
      } else if (message.type === "cancel") {
        finish(transfer, "cancel", "انتقال لغو شد.");
      } else if (message.type === "abort") {
        // A broken peer reports a failure, not a user cancellation, so the other side shows an error.
        finish(transfer, "error", typeof message.reason === "string" && message.reason ? message.reason.slice(0, 140) : "انتقال به دلیل خطا متوقف شد.");
      } else if (message.type === "complete" && transfer.from === id && transfer.accepted) {
        clearTimeout(transfer.timer);
        transfers.delete(transfer.id);
      } else if (message.type === "signal" && transfer.accepted && validSignal(message.data)) {
        const to = transfer.from === id ? transfer.to : transfer.from;
        send(peers.get(to), { type: "signal", id: transfer.id, from: id, data: message.data });
      }
    });
    socket.on("close", () => {
      peers.delete(id);
      for (const transfer of transfers.values()) {
        if (transfer.from === id || transfer.to === id) finish(transfer, "cancel", "ارتباط با دستگاه مقابل قطع شد.");
      }
      broadcastPeers();
    });
  });
  const heartbeat = setInterval(() => {
    for (const peer of peers.values()) {
      if (!peer.alive) peer.socket.terminate();
      else { peer.alive = false; peer.socket.ping(); }
    }
  }, HEARTBEAT_INTERVAL);
  heartbeat.unref();
  return {
    wss,
    close() {
      clearInterval(heartbeat);
      for (const transfer of transfers.values()) clearTimeout(transfer.timer);
      transfers.clear();
      for (const peer of peers.values()) peer.socket.terminate();
      wss.close();
    },
  };
}
