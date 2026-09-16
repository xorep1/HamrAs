export const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;
export const MAX_MEMORY_FILE_SIZE = 256 * 1024 * 1024;
// Wire chunk. 64 KiB is the safe cross-browser floor; Chrome and Edge negotiate 256 KiB and the
// sender clamps to whatever the two peers actually agreed on. A 4x larger chunk means a quarter of
// the send calls, message events and validations per byte.
export const CHUNK_SIZE = 256 * 1024;
export const FALLBACK_CHUNK_SIZE = 64 * 1024;
export const MIN_CHUNK_SIZE = 16 * 1024;
// Reading the file is dominated by the per-call cost, not the byte count: a 64 KiB slice costs about
// as much as a 16 MiB one, so the sender reads large blocks and still puts CHUNK_SIZE messages on the
// wire. The next block is read while the current one is still going out, so a read never idles the link.
export const READ_AHEAD = 16 * 1024 * 1024;
// Bytes allowed to sit in the transport's own send queue. The browser tears a channel down somewhere
// above 16 MiB queued, so this stays well below it and YIELD_INTERVAL bounds the overshoot.
export const SEND_WINDOW = 8 * 1024 * 1024;
// Refill at half the window rather than a quarter, so the send queue is topped up before it runs dry.
export const BUFFER_LOW_THRESHOLD = SEND_WINDOW / 2;
// Unacknowledged bytes allowed in flight. This is not the send queue: it only bounds receiver memory,
// so it can be far wider, and a receiver whose disk lags no longer stalls the wire.
export const CREDIT_WINDOW = 32 * 1024 * 1024;
// The receiver admits a wider window than the sender's credit so in-flight chunks never trip the bound.
export const RECEIVE_WINDOW = 2 * CREDIT_WINDOW;
export const MAX_QUEUED_MESSAGES = 256;
// Chunks are coalesced into one large write. A write costs roughly as much per call as per byte, so
// writing 8 MiB once instead of 64 KiB 128 times is the largest single win on the disk path.
export const WRITE_BLOCK = 8 * 1024 * 1024;
// The receiver acknowledges every written block, so a slow disk still reports progress and
// returns credit; a drained queue is acknowledged too, which keeps small files responsive.
export const ACK_INTERVAL = 4 * 1024 * 1024;
export const DRAIN_ACK_INTERVAL = 256 * 1024;
// A task turn every this many bytes lets channel.bufferedAmount refresh, so the send window is
// never overshot by more than this and the browser's internal send queue cannot fill up.
export const YIELD_INTERVAL = 1024 * 1024;
// Host storage is a separate feature from the peer-to-peer path: these files DO live on the server.
// Uploading is gated by a password, listing and downloading are deliberately open to the whole LAN.
export const MAX_HOST_FILE_SIZE = 4 * 1024 * 1024 * 1024;
// A whole-library ceiling so one careless upload run cannot fill the host disk.
export const MAX_HOST_TOTAL_SIZE = 20 * 1024 * 1024 * 1024;
export const HOST_UPLOAD_CHUNK = 4 * 1024 * 1024;
// Stored bytes are served as a download by default. Only this allowlist may render in the browser,
// and even then under a sandbox CSP, so an uploaded page can never run as same-origin script.
const INLINE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "video/mp4", "video/webm", "video/ogg", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/webm", "audio/flac", "application/pdf", "text/plain"];

export function validHostId(value) {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

export function inlineViewable(mime) {
  return typeof mime === "string" && INLINE_TYPES.includes(mime.split(";")[0].trim().toLowerCase());
}

export function validHostName(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  // Control characters and bidi overrides are rejected by code point: an override can disguise a
  // dangerous extension in a right-to-left listing, and the value is shown to every LAN user.
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return false;
    if (code >= 0x202a && code <= 0x202e) return false;
    if (code >= 0x2066 && code <= 0x2069) return false;
  }
  return true;
}

export const OFFER_TIMEOUT = 60_000;
export const IDLE_TIMEOUT = 45_000;
// Closing a writable can take a while on a slow disk, so finalizing gets its own budget.
export const FINALIZE_TIMEOUT = 90_000;
// Closing a data channel is indistinguishable from an intentional cancel at the transport
// level, so a peer waits this long for the signaling cancel before reporting a broken link.
export const CANCEL_GRACE = 1_000;
export const HEARTBEAT_INTERVAL = 4_000;

export function validId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(value);
}

export function validFile(file) {
  return file !== null && typeof file === "object"
    && typeof file.name === "string" && file.name.length > 0 && file.name.length <= 255
    && typeof file.mime === "string" && file.mime.length <= 150
    && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_FILE_SIZE;
}

export function cleanName(value) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 32)
    : "";
}

export function safeFilename(name) {
  return name.replace(/[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "_") || "download";
}

export function percent(bytes, total) {
  return total === 0 ? 0 : Math.min(100, Math.max(0, Math.floor(bytes / total * 100)));
}

export function isPrivateAddress(address = "") {
  const ip = address.toLowerCase().split("%")[0].replace(/^::ffff:/, "");
  return ip === "::1" || ip === "127.0.0.1"
    || /^10\./.test(ip) || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip)
    || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}

// A private message or a stored host text is shown verbatim in the LAN UI, so the only rules are that
// it exists, is not blank and fits the wire. Leading/trailing whitespace, internal newlines and markup
// are part of what the user typed and must survive untouched, so nothing here trims or rewrites text.
export const MAX_MESSAGE_LENGTH = 4000;

export function validMessageText(text) {
  return typeof text === "string" && text.length > 0 && text.length <= MAX_MESSAGE_LENGTH && /\S/.test(text);
}

export function validSignal(data) {
  if (!data || typeof data !== "object") return false;
  if (data.description) {
    return ["offer", "answer"].includes(data.description.type)
      && typeof data.description.sdp === "string" && data.description.sdp.length <= 24_000;
  }
  return data.candidate && typeof data.candidate.candidate === "string"
    && data.candidate.candidate.length <= 4_000
    && (data.candidate.sdpMid == null || typeof data.candidate.sdpMid === "string")
    && (data.candidate.sdpMLineIndex == null || Number.isInteger(data.candidate.sdpMLineIndex));
}
