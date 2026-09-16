import { MAX_HOST_FILE_SIZE, MAX_MESSAGE_LENGTH } from "./protocol.mjs";

export type HostFile = { id: string; name: string; size: number; mime: string; uploadedAt: number; viewable: boolean };
export type HostStats = { files: number; bytes: number; maxFileSize: number; maxTotalSize: number; remaining: number };
export type HostListing = { files: HostFile[]; stats: HostStats };
// A text kept on the host is public to the LAN, exactly like a stored file: the password gates writing.
export type HostText = { id: string; text: string; createdAt: number };

const BASE = "/api/host/files";
const TEXT_BASE = "/api/host/messages";
export const MAX_HOST_TEXT = MAX_MESSAGE_LENGTH;
export const hostDownloadUrl = (file: HostFile) => `${BASE}/${file.id}`;
export const hostViewUrl = (file: HostFile) => `${BASE}/${file.id}?inline=1`;

async function fail(response: Response, fallback: string): Promise<never> {
  let message = fallback;
  try {
    const body = await response.json();
    if (body && typeof body.error === "string") message = body.error;
  } catch { /* A non-JSON body means the generic message stands. */ }
  throw new Error(message);
}

// Reading is deliberately unauthenticated: no password is sent on this path.
export async function listHostFiles(signal?: AbortSignal): Promise<HostListing> {
  const response = await fetch(BASE, { signal, cache: "no-store" });
  if (!response.ok) return fail(response, "فهرست فایل‌های هاست خوانده نشد.");
  return response.json();
}

export async function checkHostPassword(password: string): Promise<void> {
  const response = await fetch("/api/host/session", { method: "POST", headers: { "x-hamras-password": password } });
  if (!response.ok) return fail(response, "رمز آپلود پذیرفته نشد.");
}

export async function deleteHostFile(id: string, password: string): Promise<void> {
  const response = await fetch(`${BASE}/${id}`, { method: "DELETE", headers: { "x-hamras-password": password } });
  if (!response.ok) return fail(response, "حذف فایل ناموفق بود.");
}

// Stored texts are readable by everyone on the LAN, so no credentials travel on this path either.
export async function listHostTexts(signal?: AbortSignal): Promise<HostText[]> {
  const response = await fetch(TEXT_BASE, { signal, cache: "no-store" });
  if (!response.ok) return fail(response, "فهرست متن‌های روی هاست خوانده نشد.");
  const body = (await response.json()) as { messages?: HostText[] };
  return Array.isArray(body?.messages) ? body.messages : [];
}

export async function saveHostText(text: string, password: string): Promise<HostText> {
  const response = await fetch(TEXT_BASE, {
    method: "POST",
    headers: { "x-hamras-password": password, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) return fail(response, "ذخیرهٔ متن روی هاست ناموفق بود.");
  const body = (await response.json()) as { message?: HostText };
  if (!body?.message) throw new Error("ذخیرهٔ متن روی هاست ناموفق بود.");
  return body.message;
}

export async function deleteHostText(id: string, password: string): Promise<void> {
  const response = await fetch(`${TEXT_BASE}/${id}`, { method: "DELETE", headers: { "x-hamras-password": password } });
  if (!response.ok) return fail(response, "حذف متن ناموفق بود.");
}

export type UploadHandle = { promise: Promise<HostFile>; abort(): void };

// XHR rather than fetch: it is still the only way to observe upload progress on a 4 GiB body.
export function uploadHostFile(file: File, password: string, onProgress: (sent: number, total: number) => void): UploadHandle {
  const request = new XMLHttpRequest();
  const promise = new Promise<HostFile>((resolve, reject) => {
    if (file.size > MAX_HOST_FILE_SIZE) { reject(new Error("این فایل از سقف مجاز آپلود روی هاست بزرگ‌تر است.")); return; }
    request.open("POST", BASE, true);
    request.responseType = "json";
    request.setRequestHeader("x-hamras-password", password);
    // The name travels percent-encoded: a header may not carry raw non-ASCII bytes.
    request.setRequestHeader("x-hamras-name", encodeURIComponent(file.name));
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.upload.onprogress = (event) => onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
    request.onload = () => {
      const body = request.response as { file?: HostFile; error?: string } | null;
      if (request.status === 201 && body?.file) { onProgress(file.size, file.size); resolve(body.file); return; }
      reject(new Error(body?.error || (request.status === 401 ? "رمز آپلود درست نیست." : "آپلود روی هاست ناموفق بود.")));
    };
    request.onerror = () => reject(new Error("ارتباط با هاست در میانهٔ آپلود قطع شد."));
    request.ontimeout = () => reject(new Error("زمان آپلود تمام شد."));
    request.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    request.send(file);
  });
  return { promise, abort: () => request.abort() };
}
