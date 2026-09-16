import { ACK_INTERVAL, BUFFER_LOW_THRESHOLD, CANCEL_GRACE, CHUNK_SIZE, CREDIT_WINDOW, DRAIN_ACK_INTERVAL, FALLBACK_CHUNK_SIZE, FINALIZE_TIMEOUT, IDLE_TIMEOUT, MAX_MEMORY_FILE_SIZE, MAX_QUEUED_MESSAGES, MIN_CHUNK_SIZE, OFFER_TIMEOUT, READ_AHEAD, RECEIVE_WINDOW, SEND_WINDOW, WRITE_BLOCK, YIELD_INTERVAL, percent, safeFilename, validFile, validMessageText } from "./protocol.mjs";

// A macrotask turn without timer clamping: this lets the transport refresh channel.bufferedAmount.
function taskTurn(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
    channel.port2.postMessage(0);
  });
}

type SaveHandle = { name: string; createWritable(): Promise<FileSystemWritableFileStream> };
type SaveWindow = Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<SaveHandle> };
const supportsDirectSave = () => window.isSecureContext && typeof (window as SaveWindow).showSaveFilePicker === "function";
const diskRequired = "دریافت فایل بزرگ‌تر از ۲۵۶ مگابایت به ذخیرهٔ مستقیم نیاز دارد؛ از Chrome یا Edge دسکتاپ با HTTPS معتبر استفاده کنید (localhost فقط روی میزبان).";

export type Peer = { id: string; name: string; device: "mobile" | "desktop" };
export type ChatMessage = { id: string; peerId: string; peer: string; text: string; sentAt: number; direction: "send" | "receive"; status: "pending" | "sent" | "received" | "error"; detail?: string };
export type FileMeta = { name: string; size: number; mime: string };
export type Transfer = {
  id: string;
  direction: "send" | "receive";
  peer: string;
  file: FileMeta;
  status: "waiting" | "connecting" | "transferring" | "finalizing" | "complete" | "cancelled" | "error";
  storage?: "disk" | "memory";
  savedName?: string;
  bytes: number;
  progress: number;
  speed: number;
  detail?: string;
  url?: string;
};
export type Snapshot = {
  connection: "connecting" | "online" | "offline" | "unsupported";
  directSave: boolean;
  choosingSave: boolean;
  id: string;
  name: string;
  peers: Peer[];
  messages: ChatMessage[];
  chatError: string;
  transfer: Transfer | null;
  incoming: { id: string; from: string; name: string; file: FileMeta } | null;
  error: string;
};
type Signal = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
type Message = {
  type: string;
  id?: string;
  name?: string;
  from?: string;
  to?: string;
  toName?: string;
  text?: string;
  sentAt?: number;
  reason?: string;
  file?: FileMeta;
  peers?: Peer[];
  data?: Signal;
};
type Session = {
  id: string;
  direction: "send" | "receive";
  file: FileMeta;
  source?: File;
  pc?: RTCPeerConnection;
  channel?: RTCDataChannel;
  candidates: RTCIceCandidateInit[];
  chunks: ArrayBuffer[];
  writeBuffer: ArrayBuffer[];
  writeBufferBytes: number;
  chunkSize: number;
  writable?: FileSystemWritableFileStream;
  savedName?: string;
  receiving: Promise<void>;
  pendingBytes: number;
  pendingMessages: number;
  unacked: number;
  endReceived: boolean;
  credit?: { resolve(): void; reject(error: Error): void };
  finalizingAt?: number;
  lastActivity: number;
  queued: number;
  bytes: number;
  started: number;
  touched: number;
  lastRender: number;
  lastAck: number;
  done: boolean;
  canceling: boolean;
  gapTimer?: ReturnType<typeof setTimeout>;
  watchdog?: ReturnType<typeof setInterval>;
};

export const initialSnapshot: Snapshot = {
  connection: "connecting", directSave: false, choosingSave: false, id: "", name: "", peers: [], messages: [], chatError: "", transfer: null, incoming: null, error: "",
};
export const isBusy = (transfer: Transfer | null) => !!transfer && ["waiting", "connecting", "transferring", "finalizing"].includes(transfer.status);

function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class TransferClient {
  private state: Snapshot = { ...initialSnapshot };
  private socket?: WebSocket;
  private session?: Session;
  private stopped = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private retry = 1000;
  private objectUrl?: string;
  private chatTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inbound: Promise<void> = Promise.resolve();
  private readonly onOffline = () => this.sleep();
  private readonly onOnline = () => this.wake();

  constructor(private readonly onChange: (state: Snapshot) => void) {}

  private update(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch };
    if (!this.stopped) this.onChange(this.state);
  }

  private transfer(patch: Partial<Transfer>) {
    if (this.state.transfer) this.update({ transfer: { ...this.state.transfer, ...patch } });
  }

  start() {
    this.update({ directSave: supportsDirectSave() });
    if (typeof RTCPeerConnection === "undefined") {
      this.update({ connection: "unsupported", error: "مرورگر از WebRTC پشتیبانی نمی‌کند؛ با یک مرورگر به‌روز دوباره امتحان کنید." });
      return;
    }
    try { this.state.name = localStorage.getItem("hamras-name") || ""; } catch { /* Storage is optional. */ }
    window.addEventListener("offline", this.onOffline);
    window.addEventListener("online", this.onOnline);
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    this.update({ connection: "connecting" });
    const url = new URL("/signal", window.location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (event) => {
      this.inbound = this.inbound.then(async () => {
        if (this.socket !== socket || this.stopped) return;
        const message = JSON.parse(event.data) as Message;
        await this.handle(message);
      }).catch(() => this.fail("خطایی در برقراری ارتباط رخ داد؛ دوباره تلاش کنید."));
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.stopped || this.socket !== socket) return;
      this.interruptMessages();
      this.fail("ارتباط با میزبان قطع شد. پس از اتصال دوباره، فایل را مجدداً ارسال کنید.", false);
      this.update({ connection: "offline", peers: [], incoming: null });
      this.reconnect = setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 10_000);
    };
  }

  private sleep() {
    clearTimeout(this.reconnect);
    this.update({ connection: "offline", peers: [], incoming: null });
    this.socket?.close();
  }

  private wake() {
    if (this.stopped) return;
    clearTimeout(this.reconnect);
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) return;
    this.connect();
  }

  private send(message: object) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  rename(name: string) {
    const value = name.trim().slice(0, 32);
    if (!value) return;
    try { localStorage.setItem("hamras-name", value); } catch { /* Storage is optional. */ }
    this.update({ name: value });
    this.send({ type: "join", name: value, device: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ? "mobile" : "desktop" });
  }

  dismissError() { this.update({ error: "" }); }

  sendMessage(text: string, to: string): boolean {
    if (!validMessageText(text)) { this.update({ chatError: "متن پیام خالی یا بیش از حد طولانی است." }); return false; }
    const peer = this.state.peers.find((item) => item.id === to);
    if (this.state.connection !== "online" || !peer || this.socket?.readyState !== WebSocket.OPEN) {
      this.update({ chatError: "گیرنده آنلاین نیست؛ اتصال و دستگاه مقصد را بررسی کنید." }); return false;
    }
    if (this.chatTimers.size >= 10) { this.update({ chatError: "منتظر نتیجهٔ ارسال پیام‌های قبلی بمانید." }); return false; }
    const id = newId();
    const message: ChatMessage = { id, peerId: peer.id, peer: peer.name, text, sentAt: Date.now(), direction: "send", status: "pending" };
    this.update({ messages: [...this.state.messages, message].slice(-100), chatError: "" });
    this.chatTimers.set(id, setTimeout(() => this.finishChat(id, "error", "تأیید ارسال نرسید؛ پیش از ارسال دوباره، دریافت پیام را بررسی کنید."), 15_000));
    try {
      if (!this.send({ type: "chat", id, to, text })) throw new Error("Offline");
      return true;
    } catch {
      this.finishChat(id, "error", "ارتباط با میزبان قطع شد؛ پیام ارسال نشد.");
      return false;
    }
  }

  private finishChat(id: string, status: "sent" | "error", detail?: string) {
    clearTimeout(this.chatTimers.get(id));
    this.chatTimers.delete(id);
    this.update({ messages: this.state.messages.map((item) => item.id === id && item.direction === "send" ? { ...item, status, detail } : item) });
  }

  private interruptMessages() {
    for (const id of this.chatTimers.keys()) this.finishChat(id, "error", "اتصال قطع شد؛ نتیجهٔ ارسال مشخص نیست.");
  }

  request(file: File, peer: Peer) {
    if (this.state.connection !== "online") { this.update({ error: "ابتدا به میزبان متصل شوید." }); return; }
    if (isBusy(this.state.transfer) || this.state.incoming || this.state.choosingSave) { this.update({ error: "ابتدا انتقال فعلی را تمام یا لغو کنید." }); return; }
    const meta = { name: file.name, size: file.size, mime: file.type || "application/octet-stream" };
    if (!validFile(meta)) { this.update({ error: "فایل نامعتبر است؛ حداکثر اندازهٔ فایل ۵ گیگابایت است." }); return; }
    this.prepare();
    const id = newId();
    this.session = this.newSession(id, "send", meta, file);
    this.update({ error: "", transfer: { id, direction: "send", peer: peer.name, file: meta, status: "waiting", bytes: 0, progress: 0, speed: 0 } });
    this.send({ type: "offer", id, to: peer.id, file: meta });
  }

  async accept() {
    const incoming = this.state.incoming;
    if (!incoming || this.state.connection !== "online" || this.state.choosingSave || this.stopped) return;
    const direct = supportsDirectSave();
    if (!direct && incoming.file.size > MAX_MEMORY_FILE_SIZE) {
      this.send({ type: "abort", id: incoming.id, reason: diskRequired });
      this.update({ incoming: null, error: diskRequired });
      return;
    }
    const current = () => !this.stopped && this.state.incoming === incoming && this.state.connection === "online";
    let writable: FileSystemWritableFileStream | undefined;
    let savedName: string | undefined;
    this.update({ choosingSave: true, error: "" });
    try {
      if (direct) {
        // Invoke the picker before any await: transient user activation belongs to this click.
        const handle = await (window as SaveWindow).showSaveFilePicker!({ suggestedName: safeFilename(incoming.file.name) });
        if (!current()) return;
        writable = await handle.createWritable();
        if (!current()) { await writable.abort().catch(() => {}); return; }
        savedName = handle.name;
      }
      if (!current()) return;
      this.prepare();
      const session = this.newSession(incoming.id, "receive", incoming.file);
      session.writable = writable;
      session.savedName = savedName;
      this.session = session;
      this.update({ incoming: null, error: "", transfer: { id: incoming.id, direction: "receive", peer: incoming.name, file: incoming.file, status: "connecting", storage: direct ? "disk" : "memory", bytes: 0, progress: 0, speed: 0 } });
      this.makePeer(session);
      if (!this.send({ type: "accept", id: incoming.id })) this.fail("ارتباط با میزبان قطع شد.", false);
    } catch (error) {
      if (writable) await writable.abort().catch(() => {});
      if (this.session?.id === incoming.id && !this.session.done) this.fail("آماده‌سازی دریافت فایل ناموفق بود.");
      if (!current()) return;
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      this.send({ type: cancelled ? "reject" : "abort", id: incoming.id, reason: "انتخاب یا بازکردن فایل مقصد ناموفق بود." });
      this.update({ incoming: null, error: cancelled ? "انتخاب محل ذخیره لغو شد؛ فایلی دریافت نشد." : "بازکردن فایل مقصد ممکن نشد؛ دسترسی نوشتن و فضای دیسک را بررسی کنید." });
    } finally {
      this.update({ choosingSave: false });
    }
  }

  reject() {
    if (this.state.incoming) this.send({ type: "reject", id: this.state.incoming.id });
    this.update({ incoming: null });
  }

  cancel() {
    const session = this.session;
    if (!session || session.done) return;
    session.canceling = true;
    this.send({ type: "cancel", id: session.id });
    this.transfer({ status: "cancelled", detail: "انتقال توسط شما لغو شد." });
    this.cleanup(session);
  }

  private prepare() {
    if (this.session) this.cleanup(this.session);
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
  }

  private newSession(id: string, direction: Session["direction"], file: FileMeta, source?: File): Session {
    const session: Session = {
      id, direction, file, source, candidates: [], chunks: [], writeBuffer: [], writeBufferBytes: 0,
      chunkSize: FALLBACK_CHUNK_SIZE, queued: 0, bytes: 0,
      receiving: Promise.resolve(), pendingBytes: 0, pendingMessages: 0, unacked: 0, endReceived: false, lastActivity: 0,
      started: 0, touched: Date.now(), lastRender: 0, lastAck: 0, done: false, canceling: false,
    };
    session.watchdog = setInterval(() => {
      if (session.done || this.session !== session) return;
      const now = Date.now();
      if (session.finalizingAt !== undefined) {
        if (now - session.finalizingAt > FINALIZE_TIMEOUT) { this.fail("نهایی‌سازی ذخیره بیش از حد طول کشید؛ فضای دیسک را بررسی کنید."); return; }
      } else {
        const limit = this.state.transfer?.status === "waiting" ? OFFER_TIMEOUT + 2000 : IDLE_TIMEOUT;
        if (now - session.touched > limit) { this.fail("پاسخی دریافت نشد. شبکه، سرعت دیسک و فایروال را بررسی کنید."); return; }
      }
      if (this.state.transfer?.status !== "waiting" && now - session.lastActivity >= 4000) {
        this.send({ type: "activity", id: session.id });
        session.lastActivity = now;
      }
    }, 1000);
    return session;
  }

  private async handle(message: Message) {
    if (message.type === "chat-error") {
      if (message.id) this.finishChat(message.id, "error", message.reason || "ارسال پیام ناموفق بود.");
      return;
    }
    if (message.type === "chat-sent") {
      if (message.id) this.finishChat(message.id, "sent");
      return;
    }
    if (message.type === "chat") {
      if (!message.id || !message.from || message.to !== this.state.id || !validMessageText(message.text)) return;
      const item: ChatMessage = { id: message.id, peerId: message.from, peer: message.name || "دستگاه", text: message.text!, sentAt: message.sentAt || Date.now(), direction: "receive", status: "received" };
      this.update({ messages: [...this.state.messages, item].slice(-100) });
      return;
    }
    if (message.type === "welcome") {
      this.retry = 1000;
      this.update({ connection: "online", id: message.id!, name: this.state.name || `دستگاه ${message.id!.slice(0, 4)}`, error: "" });
      this.rename(this.state.name);
      return;
    }
    if (message.type === "peers") {
      this.update({ peers: (message.peers || []).filter((peer) => peer.id !== this.state.id) });
      return;
    }
    if (message.type === "offer") {
      if (!message.file || !validFile(message.file) || isBusy(this.state.transfer) || this.state.incoming || this.state.choosingSave) {
        this.send({ type: "reject", id: message.id }); return;
      }
      if (!supportsDirectSave() && message.file.size > MAX_MEMORY_FILE_SIZE) {
        this.send({ type: "abort", id: message.id, reason: diskRequired });
        this.update({ error: diskRequired });
        return;
      }
      this.update({ incoming: { id: message.id!, from: message.from!, name: message.name!, file: message.file } });
      return;
    }
    if (["reject", "cancel", "error"].includes(message.type)) {
      if (message.id === this.state.incoming?.id) this.update({ incoming: null, error: message.reason || "درخواست لغو شد." });
      const session = this.session;
      if (session && message.id === session.id && !session.done) {
        session.canceling = true;
        this.transfer({ status: message.type === "error" ? "error" : "cancelled", detail: message.reason });
        this.cleanup(session);
      } else if (message.type === "error") this.update({ error: message.reason || "درخواست نامعتبر است." });
      return;
    }
    const session = this.session;
    if (!session || session.done || message.id !== session.id) return;
    session.touched = Date.now();
    if (message.type === "accept" && session.direction === "send" && !session.pc) {
      this.transfer({ status: "connecting" });
      const pc = this.makePeer(session);
      this.bindChannel(session, pc.createDataChannel("file", { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      this.send({ type: "signal", id: session.id, data: { description: pc.localDescription } });
    } else if (message.type === "signal" && message.data) {
      const pc = session.pc;
      if (!pc) return;
      const { description, candidate } = message.data;
      if (description) {
        if (description.type !== (session.direction === "receive" ? "offer" : "answer")) throw new Error("Unexpected description");
        await pc.setRemoteDescription(description);
        for (const item of session.candidates.splice(0)) await pc.addIceCandidate(item);
        if (description.type === "offer") {
          await pc.setLocalDescription(await pc.createAnswer());
          this.send({ type: "signal", id: session.id, data: { description: pc.localDescription } });
        }
      } else if (candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(candidate);
        else if (session.candidates.length < 128) session.candidates.push(candidate);
      }
    }
  }

  private makePeer(session: Session) {
    const pc = new RTCPeerConnection({ iceServers: [] });
    session.pc = pc;
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && !session.done) this.send({ type: "signal", id: session.id, data: { candidate: candidate.toJSON() } });
    };
    pc.onconnectionstatechange = () => {
      if (!session.done && this.session === session && ["failed", "closed"].includes(pc.connectionState)) this.gap(session, "ارتباط مستقیم برقرار نشد یا قطع شد. شبکه و فایروال را بررسی کنید.");
    };
    pc.ondatachannel = ({ channel }) => {
      if (session.direction !== "receive" || session.channel || channel.label !== "file") { channel.close(); return; }
      this.bindChannel(session, channel);
    };
    return pc;
  }

  private bindChannel(session: Session, channel: RTCDataChannel) {
    session.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFER_LOW_THRESHOLD;
    channel.onopen = () => {
      if (session.done || this.session !== session) return;
      // The two peers agreed an SCTP message ceiling while negotiating; use as much of it as allowed.
      const ceiling = session.pc?.sctp?.maxMessageSize || FALLBACK_CHUNK_SIZE;
      session.chunkSize = Math.max(MIN_CHUNK_SIZE, Math.min(CHUNK_SIZE, ceiling));
      session.started = session.touched = Date.now();
      this.transfer({ status: "transferring" });
      if (session.direction === "send") void this.pump(session).catch(() => {
        if (!session.done && this.session === session) this.fail("ارسال فایل متوقف شد؛ دوباره تلاش کنید.");
      });
    };
    channel.onmessage = (event) => {
      if (session.done || this.session !== session) return;
      const data: unknown = event.data;
      try {
        if (session.direction === "send") {
          if (typeof data !== "string" || data.length > 1024) throw new Error("Invalid control");
          void this.control(session, JSON.parse(data)).catch(() => {
            if (!session.done && this.session === session) this.fail("تأیید دریافت معتبر نبود؛ انتقال متوقف شد.");
          });
          return;
        }
        if (session.endReceived) throw new Error("Data after end");
        let length = 0;
        if (typeof data === "string") {
          if (data.length > 1024 || JSON.parse(data)?.type !== "end") throw new Error("Invalid control");
          session.endReceived = true;
        } else {
          if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > CHUNK_SIZE) throw new Error("Invalid chunk");
          length = data.byteLength;
          if (session.bytes + session.writeBufferBytes + session.pendingBytes + length > session.file.size
            || session.writeBufferBytes + session.pendingBytes + length > RECEIVE_WINDOW) throw new Error("Receive window exceeded");
        }
        if (++session.pendingMessages > MAX_QUEUED_MESSAGES) throw new Error("Too many queued messages");
        session.pendingBytes += length;
        // A bounded queue serializes disk writes; ACK credit is returned only after write resolves.
        session.receiving = session.receiving.then(async () => {
          try {
            if (session.done || this.session !== session) return;
            if (typeof data === "string") {
              await this.control(session, JSON.parse(data));
            } else {
              const chunk = data as ArrayBuffer;
              const drained = session.pendingMessages === 1;
              if (session.writable) {
                // Chunks are gathered and handed to the disk in one large block, or right away when
                // nothing else is queued behind them so small files still finish immediately.
                session.writeBuffer.push(chunk);
                session.writeBufferBytes += chunk.byteLength;
                session.touched = Date.now();
                // Buffered bytes count towards the displayed progress, so a large block does not make
                // the bar jump; only credit and the completeness check wait for the write to land.
                this.progress(session, session.writeBufferBytes);
                if (session.writeBufferBytes >= WRITE_BLOCK || drained) await this.flushWrites(session, drained);
                return;
              }
              if (session.bytes + chunk.byteLength > MAX_MEMORY_FILE_SIZE) throw new Error("Memory limit exceeded");
              session.chunks.push(chunk);
              if (session.done || this.session !== session) return;
              session.bytes += chunk.byteLength;
              session.unacked += chunk.byteLength;
              session.touched = Date.now();
              this.progress(session);
              // Acknowledgements are batched: every message back also costs a send on the same
              // channel, so an idle queue acks at a shorter interval instead of per chunk.
              if (session.unacked >= (drained ? DRAIN_ACK_INTERVAL : ACK_INTERVAL)) {
                session.unacked = 0;
                channel.send(JSON.stringify({ type: "progress", bytes: session.bytes }));
              }
            }
          } finally {
            session.pendingBytes -= length;
            session.pendingMessages--;
          }
        }).catch(() => {
          if (!session.done && this.session === session) this.fail("دریافت یا نوشتن فایل متوقف شد؛ فضای دیسک و مجوز ذخیره را بررسی کنید.");
        });
      } catch { this.fail("اطلاعات فایل یا اندازهٔ صف دریافت معتبر نبود؛ انتقال متوقف شد."); }
    };
    channel.onclose = () => {
      if (session.done || this.session !== session) { this.cleanup(session); return; }
      if (session.canceling) { this.cleanup(session); return; }
      this.gap(session, "ارتباط با دستگاه مقابل قطع شد. انتقال را دوباره شروع کنید.");
    };
    channel.onerror = () => {
      if (!session.done && this.session === session) this.gap(session, "کانال انتقال فایل با خطا مواجه شد.");
    };
  }

  private async control(session: Session, message: { type: string; bytes?: number }) {
    const channel = session.channel!;
    if (session.direction === "send" && ["progress", "received"].includes(message.type)) {
      if (!Number.isSafeInteger(message.bytes) || message.bytes! < session.bytes || message.bytes! > session.queued) throw new Error("Invalid acknowledgement");
      if (message.bytes! > session.bytes) session.touched = Date.now();
      session.bytes = message.bytes!;
      session.credit?.resolve();
      this.progress(session);
      if (session.bytes === session.file.size && session.finalizingAt === undefined) {
        session.finalizingAt = Date.now();
        this.transfer({ status: "finalizing" });
      }
      if (message.type === "received") {
        if (session.bytes !== session.file.size || session.queued !== session.file.size) throw new Error("Incomplete receipt");
        this.transfer({ status: "complete", bytes: session.file.size, progress: 100 });
        this.send({ type: "complete", id: session.id });
        this.cleanup(session);
      }
    } else if (message.type === "end" && session.direction === "receive") {
      if (session.writable) await this.flushWrites(session, true);
      if (session.done || this.session !== session) return;
      if (session.bytes !== session.file.size) throw new Error("Incomplete file");
      session.finalizingAt = Date.now();
      this.transfer({ status: "finalizing", progress: Math.min(99, percent(session.bytes, session.file.size)) });
      if (session.writable) {
        await session.writable.close();
        session.writable = undefined;
        if (session.done || this.session !== session) return;
      } else {
        this.objectUrl = URL.createObjectURL(new Blob(session.chunks, { type: "application/octet-stream" }));
        session.chunks = [];
      }
      channel.send(JSON.stringify({ type: "received", bytes: session.bytes }));
      session.done = true;
      clearInterval(session.watchdog);
      this.transfer({ status: "complete", bytes: session.file.size, progress: 100, url: this.objectUrl, savedName: session.savedName });
    } else throw new Error("Unexpected control message");
  }

  // One write per accumulated block instead of one per chunk. Credit is still returned only once the
  // write resolves, so a slow disk keeps gating the sender and receiver memory stays bounded.
  private async flushWrites(session: Session, drained: boolean) {
    const total = session.writeBufferBytes;
    if (!total || !session.writable) return;
    const parts = session.writeBuffer;
    session.writeBuffer = [];
    session.writeBufferBytes = 0;
    let block: Uint8Array<ArrayBuffer>;
    if (parts.length === 1) block = new Uint8Array(parts[0]);
    else {
      block = new Uint8Array(total);
      let at = 0;
      for (const part of parts) { block.set(new Uint8Array(part), at); at += part.byteLength; }
    }
    await session.writable.write(block);
    if (session.done || this.session !== session) return;
    session.bytes += total;
    session.unacked += total;
    session.touched = Date.now();
    this.progress(session);
    if (session.unacked >= (drained ? DRAIN_ACK_INTERVAL : ACK_INTERVAL) || session.bytes === session.file.size) {
      session.unacked = 0;
      session.channel?.send(JSON.stringify({ type: "progress", bytes: session.bytes }));
    }
  }

  private progress(session: Session, extra = 0) {
    const shown = session.bytes + extra;
    const now = Date.now();
    if (now - session.lastRender < 100 && shown !== session.file.size) return;
    session.lastRender = now;
    const seconds = Math.max((now - session.started) / 1000, 0.1);
    this.transfer({ bytes: shown, progress: Math.min(99, percent(shown, session.file.size)), speed: shown / seconds });
  }

  private async pump(session: Session) {
    const channel = session.channel!;
    const file = session.source!;
    const chunkSize = session.chunkSize;
    let readPos = 0;
    // The read is started before the previous block is drained, so the transport never waits on disk.
    const readNext = (): Promise<ArrayBuffer> | null => {
      if (readPos >= file.size) return null;
      const end = Math.min(readPos + READ_AHEAD, file.size);
      const pending = file.slice(readPos, end).arrayBuffer();
      readPos = end;
      pending.catch(() => { /* Surfaced when awaited; this only silences an abandoned prefetch. */ });
      return pending;
    };
    let ahead = readNext();
    let block: ArrayBuffer | null = null;
    let offset = 0;
    let sinceYield = 0;
    while (session.queued < file.size) {
      if (session.done || this.session !== session) return;
      // Receiver credit bounds the unacknowledged bytes, so a slow disk cannot balloon memory here.
      while (session.queued - session.bytes > CREDIT_WINDOW) {
        await this.awaitCredit(session);
        if (session.done || this.session !== session) return;
      }
      if (channel.bufferedAmount > SEND_WINDOW) {
        await this.waitForBuffer(channel);
        if (session.done) return;
      }
      if (!block || offset >= block.byteLength) {
        if (!ahead) break;
        block = await ahead;
        ahead = readNext();
        offset = 0;
        if (session.done || channel.readyState !== "open") return;
        if (block.byteLength === 0) break;
      }
      const size = Math.min(chunkSize, block.byteLength - offset);
      // The read block stays untouched, so a view of it is safe to hand to the transport.
      channel.send(new Uint8Array(block, offset, size));
      offset += size;
      session.queued += size;
      session.touched = Date.now();
      sinceYield += size;
      if (sinceYield >= YIELD_INTERVAL) { sinceYield = 0; await taskTurn(); }
    }
    if (!session.done && channel.readyState === "open") channel.send(JSON.stringify({ type: "end" }));
  }

  private awaitCredit(session: Session): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { finish(); reject(new Error("No acknowledgement")); }, IDLE_TIMEOUT);
      const finish = () => {
        clearTimeout(timer);
        if (session.credit === entry) session.credit = undefined;
      };
      const entry = { resolve: () => { finish(); resolve(); }, reject: (error: Error) => { finish(); reject(error); } };
      session.credit = entry;
    });
  }

  private waitForBuffer(channel: RTCDataChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        channel.removeEventListener("bufferedamountlow", ready);
        channel.removeEventListener("close", closed);
        channel.removeEventListener("error", closed);
      };
      const ready = () => { clean(); resolve(); };
      const closed = () => { clean(); reject(new Error("Channel closed")); };
      const timer = setTimeout(closed, IDLE_TIMEOUT);
      channel.addEventListener("bufferedamountlow", ready);
      channel.addEventListener("close", closed);
      channel.addEventListener("error", closed);
      if (channel.readyState !== "open") closed();
      else if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) ready();
    });
  }

  private gap(session: Session, detail: string) {
    if (session.done || session.canceling || session.gapTimer || this.session !== session) return;
    session.gapTimer = setTimeout(() => {
      session.gapTimer = undefined;
      if (!session.done && !session.canceling && this.session === session) this.fail(detail);
    }, CANCEL_GRACE);
  }

  private fail(detail: string, notify = true) {
    if (this.session && !this.session.done) {
      this.session.canceling = true;
      if (notify) this.send({ type: "abort", id: this.session.id, reason: detail });
      this.transfer({ status: "error", detail });
      this.cleanup(this.session);
    }
  }

  private cleanup(session: Session) {
    session.done = true;
    clearInterval(session.watchdog);
    clearTimeout(session.gapTimer);
    session.chunks = [];
    session.writeBuffer = [];
    session.writeBufferBytes = 0;
    session.source = undefined;
    // An unfinished disk write is abandoned so a cancelled transfer leaves no half-written file open.
    if (session.writable) { void session.writable.abort().catch(() => {}); session.writable = undefined; }
    session.credit?.reject(new Error("Session closed"));
    session.channel?.close();
    session.pc?.close();
  }

  downloadName() { return safeFilename(this.state.transfer?.file.name || "download"); }

  destroy() {
    this.stopped = true;
    clearTimeout(this.reconnect);
    window.removeEventListener("offline", this.onOffline);
    window.removeEventListener("online", this.onOnline);
    this.prepare();
    this.socket?.close();
  }
}
