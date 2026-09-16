import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";

// These tests never touch a real disk or a real native picker. window.showSaveFilePicker is replaced
// with an in-page test stand-in for the file the user would have chosen: it records every write, can
// delay each write/close, and can fail on demand. That proves the streaming contract of the page and
// the signaling client (sequential writes, integrity, no object URL, finalize-then-confirm), NOT the
// appearance of the native save dialog. Chunks are coalesced before they reach the disk, so the write
// count depends on timing: these tests assert ordering, byte-for-byte integrity and the block ceiling,
// never an exact number of writes. CHUNK_SIZE is the wire ceiling, WRITE_BLOCK the disk block ceiling.
const CHUNK_SIZE = 256 * 1024;
const WRITE_BLOCK = 8 * 1024 * 1024;
const MAX_MEMORY_FILE_SIZE = 256 * 1024 * 1024;

type DiskMock = {
  name?: string;
  pickerDelay?: number;
  pickerAbort?: boolean;
  abortFirstPicker?: boolean;
  writeDelay?: number;
  closeDelay?: number;
  failCreate?: boolean;
  failWriteAt?: number;
  failClose?: boolean;
};

// Serializable init script (runs before any page script in the receiver context).
function installDiskMock(config: DiskMock) {
  const record = {
    pickerCalls: 0, createCalls: 0, createObjectUrlCalls: 0, writeCalls: 0,
    overlap: 0, maxOverlap: 0, lengths: [] as number[], writes: [] as Uint8Array[],
    closed: false, aborted: false, suggestedName: "", name: "",
  };
  (window as unknown as { __disk: typeof record }).__disk = record;
  try {
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (...args: Parameters<typeof original>) => { record.createObjectUrlCalls += 1; return original(...args); };
  } catch { /* counting is best effort */ }

  async function bytesOf(chunk: unknown): Promise<Uint8Array> {
    if (chunk && typeof chunk === "object" && "data" in (chunk as object)) return bytesOf((chunk as { data: unknown }).data);
    if (chunk instanceof Blob) return new Uint8Array(await chunk.arrayBuffer());
    if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk.slice(0));
    if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    return new TextEncoder().encode(String(chunk));
  }

  (window as unknown as { showSaveFilePicker: (options?: { suggestedName?: string }) => Promise<unknown> }).showSaveFilePicker = async (options) => {
    record.pickerCalls += 1;
    record.suggestedName = options?.suggestedName ?? "";
    if (config.pickerDelay) await new Promise((resolve) => setTimeout(resolve, config.pickerDelay));
    if (config.pickerAbort || (config.abortFirstPicker && record.pickerCalls === 1)) throw new DOMException("The user aborted a request.", "AbortError");
    record.name = config.name ?? "hamras-disk.bin";
    return {
      name: record.name,
      createWritable: async () => {
        record.createCalls += 1;
        if (config.failCreate) throw new DOMException("Blocked by the user agent.", "NotAllowedError");
        return {
          write: async (chunk: unknown) => {
            record.overlap += 1;
            record.maxOverlap = Math.max(record.maxOverlap, record.overlap);
            if (config.writeDelay) await new Promise((resolve) => setTimeout(resolve, config.writeDelay));
            record.overlap -= 1;
            record.writeCalls += 1;
            if (config.failWriteAt && record.writeCalls === config.failWriteAt) throw new DOMException("Write failed.", "NotAllowedError");
            const copy = await bytesOf(chunk);
            record.lengths.push(copy.byteLength);
            record.writes.push(copy);
          },
          close: async () => {
            if (config.closeDelay) await new Promise((resolve) => setTimeout(resolve, config.closeDelay));
            if (config.failClose) throw new DOMException("Close failed.", "NotAllowedError");
            record.closed = true;
          },
          abort: async () => { record.aborted = true; },
          seek: async () => {},
          truncate: async () => {},
        };
      },
    };
  };
}

// Chromium on localhost is a secure context and exposes the API, so the RAM fallback must be forced
// by removing it before the page scripts run.
const removeSavePicker = () => {
  let owner: object | null = window;
  while (owner && !Object.getOwnPropertyDescriptor(owner, "showSaveFilePicker")) owner = Object.getPrototypeOf(owner);
  if (owner) { try { delete (owner as { showSaveFilePicker?: unknown }).showSaveFilePicker; } catch { /* shadow below */ } }
  if (typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker !== "undefined") {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true, writable: true });
  }
};

// Metadata-only test helper: inflate the offered size on the wire so a >256 MiB offer is exercised
// without allocating gigabytes of data.
const inflateOffer = (size: number) => {
  const original = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data === "string" && data.includes('"offer"')) {
      try {
        const message = JSON.parse(data) as { type?: string; file?: { size?: number } };
        if (message.type === "offer" && message.file) { message.file.size = size; data = JSON.stringify(message); }
      } catch { /* send the original payload */ }
    }
    return original.call(this, data as unknown as Parameters<WebSocket["send"]>[0]);
  };
};

async function named(page: Page, name: string) {
  await expect(page.getByRole("status").first()).toContainText("متصل");
  await page.getByRole("button", { name: "تغییر نام دستگاه" }).click();
  await page.getByRole("textbox", { name: "نام دستگاه" }).fill(name);
  await page.getByRole("button", { name: "ذخیره نام" }).click();
}

async function openPage(context: BrowserContext, name: string) {
  const page = await context.newPage();
  await page.goto("/");
  await named(page, name);
  return page;
}

async function senderPage(browser: Browser, inflateTo?: number) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  await context.addInitScript(removeSavePicker);
  if (inflateTo) await context.addInitScript(inflateOffer, inflateTo);
  return { context, page: await openPage(context, "رایانهٔ فرستنده") };
}

async function receiverPage(browser: Browser, disk: DiskMock | null) {
  const context = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  if (disk) await context.addInitScript(installDiskMock, disk);
  else await context.addInitScript(removeSavePicker);
  return { context, page: await openPage(context, "رایانهٔ گیرنده") };
}

async function pair(browser: Browser, disk: DiskMock | null, inflateTo?: number) {
  const a = await senderPage(browser, inflateTo);
  const b = await receiverPage(browser, disk);
  await expect(a.page.getByTestId("peer-card")).toHaveCount(1);
  await expect(b.page.getByTestId("peer-card")).toHaveCount(1);
  await a.page.getByTestId("peer-card").click();
  return { a, b };
}

async function offer(a: Page, b: Page, buffer: Buffer, name = "disk-test.bin") {
  await a.getByLabel("انتخاب فایل برای ارسال").setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  await a.getByRole("button", { name: "ارسال فایل", exact: true }).click();
  await expect(b.getByRole("dialog")).toBeVisible();
  await expect(a.getByTestId("transfer-status")).toHaveText("منتظر تأیید گیرنده");
}

const accept = (page: Page) => page.getByRole("button", { name: "پذیرفتن و دریافت" }).click();
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

type DiskRecord = { pickerCalls: number; createCalls: number; createObjectUrlCalls: number; writeCalls: number; maxOverlap: number; lengths: number[]; closed: boolean; aborted: boolean; name: string; suggestedName: string };

function readRecord(page: Page) {
  return page.evaluate(() => {
    const r = (window as unknown as { __disk: DiskRecord & { writes: Uint8Array[] } }).__disk;
    return {
      pickerCalls: r.pickerCalls, createCalls: r.createCalls, createObjectUrlCalls: r.createObjectUrlCalls,
      writeCalls: r.writeCalls, maxOverlap: r.maxOverlap, lengths: r.lengths, closed: r.closed,
      aborted: r.aborted, name: r.name, suggestedName: r.suggestedName, stored: r.writes.length,
    };
  });
}

function storedDigest(page: Page) {
  return page.evaluate(async () => {
    const chunks = (window as unknown as { __disk: { writes: Uint8Array[] } }).__disk.writes;
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const buffer = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  });
}

function watch(page: Page, errors: string[]) {
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test("direct disk save writes ordered blocks and confirms only after close", async ({ browser }) => {
  test.setTimeout(90_000);
  const { a, b } = await pair(browser, { name: "hamras-disk-target.bin", pickerDelay: 1200, writeDelay: 12, closeDelay: 700 });
  const errors: string[] = [];
  watch(a.page, errors); watch(b.page, errors);
  try {
    const data = randomBytes(300 * 1024 + 123);
    await offer(a.page, b.page, data, "گزارش-دیسک.bin");
    await expect(b.page.getByTestId("storage-note")).toContainText("ذخیرهٔ مستقیم روی دیسک");

    const acceptButton = b.page.getByRole("button", { name: "پذیرفتن و دریافت" });
    await acceptButton.click();
    // While the picker is pending the button stays visible but disabled, and the mode is announced.
    await expect(acceptButton).toBeVisible();
    await expect(acceptButton).toBeDisabled();
    await expect(b.page.getByTestId("picker-pending")).toBeVisible();
    await expect(b.page.getByTestId("transfer-mode")).toContainText("دیسک");

    // Every chunk is on disk but the file is not closed yet: progress must not read 100%.
    await expect(b.page.getByTestId("transfer-status")).toHaveText(/در حال نهایی/);
    await expect(b.page.getByTestId("finalizing-note")).toBeVisible();
    expect(Number(await b.page.getByRole("progressbar").getAttribute("aria-valuenow"))).toBeLessThan(100);
    await expect(b.page.getByText("انتقال کامل شد")).toHaveCount(0);

    await expect(b.page.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
    await expect(a.page.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
    await expect(b.page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    await expect(b.page.getByTestId("disk-saved")).toContainText("hamras-disk-target.bin");
    await expect(b.page.getByRole("link", { name: "ذخیرهٔ فایل" })).toHaveCount(0);

    const record = await readRecord(b.page);
    expect(record.suggestedName).toBe("گزارش-دیسک.bin");
    expect(record.pickerCalls).toBe(1);
    expect(record.createCalls).toBe(1);
    // Writes are coalesced, so the count is bounded rather than fixed: never more than one per chunk,
    // never a block over the ceiling, and the concatenation must equal the file exactly.
    expect(record.writeCalls).toBeGreaterThan(0);
    expect(record.writeCalls).toBeLessThanOrEqual(Math.ceil((300 * 1024 + 123) / CHUNK_SIZE));
    expect(record.lengths.reduce((sum: number, length: number) => sum + length, 0)).toBe(300 * 1024 + 123);
    expect(Math.max(...record.lengths)).toBeLessThanOrEqual(WRITE_BLOCK);
    expect(record.maxOverlap).toBe(1);
    expect(record.closed).toBe(true);
    expect(record.createObjectUrlCalls).toBe(0);
    expect(await storedDigest(b.page)).toBe(sha(data));
    expect(errors).toEqual([]);
  } finally { await a.context.close(); await b.context.close(); }
});

test("exact chunk multiples are written whole, in order, without overlap", async ({ browser }) => {
  const { a, b } = await pair(browser, { writeDelay: 4, pickerDelay: 50 });
  try {
    const data = randomBytes(2 * CHUNK_SIZE);
    await offer(a.page, b.page, data, "boundary.bin");
    await accept(b.page);
    await expect(b.page.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
    const record = await readRecord(b.page);
    expect(record.lengths.reduce((sum: number, length: number) => sum + length, 0)).toBe(2 * CHUNK_SIZE);
    expect(Math.max(...record.lengths)).toBeLessThanOrEqual(WRITE_BLOCK);
    expect(record.maxOverlap).toBe(1);
    expect(await storedDigest(b.page)).toBe(sha(data));
  } finally { await a.context.close(); await b.context.close(); }
});

test("zero-byte disk transfer completes without writes or an object URL", async ({ browser }) => {
  const { a, b } = await pair(browser, { pickerDelay: 50, writeDelay: 4 });
  try {
    await offer(a.page, b.page, Buffer.alloc(0), "empty.bin");
    await accept(b.page);
    await expect(b.page.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
    await expect(a.page.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
    await expect(b.page.getByTestId("disk-saved")).toBeVisible();
    const record = await readRecord(b.page);
    expect(record.writeCalls).toBe(0);
    expect(record.lengths).toEqual([]);
    expect(record.closed).toBe(true);
    expect(record.createObjectUrlCalls).toBe(0);
    await expect(b.page.getByRole("link", { name: "ذخیرهٔ فایل" })).toHaveCount(0);
  } finally { await a.context.close(); await b.context.close(); }
});

test("a cancelled native picker rejects the pending offer and the receiver stays usable", async ({ browser }) => {
  const { a, b } = await pair(browser, { pickerDelay: 150, writeDelay: 4, abortFirstPicker: true });
  const errors: string[] = [];
  watch(a.page, errors); watch(b.page, errors);
  try {
    await offer(a.page, b.page, Buffer.from("first"), "cancelled.bin");
    await accept(b.page);
    await expect(a.page.getByTestId("transfer-status")).toHaveText("انتقال لغو شد");
    await expect(a.page.getByRole("button", { name: "لغو انتقال" })).toHaveCount(0);
    await expect(b.page.getByRole("dialog")).not.toBeVisible();
    await expect(b.page.getByText("انتقال کامل شد")).toHaveCount(0);
    expect((await readRecord(b.page)).createCalls).toBe(0);

    await offer(a.page, b.page, Buffer.from("second attempt"), "retry.bin");
    await accept(b.page);
    await expect(b.page.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
    await expect(a.page.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
    expect(await storedDigest(b.page)).toBe(sha(Buffer.from("second attempt")));
    expect(errors).toEqual([]);
  } finally { await a.context.close(); await b.context.close(); }
});

test("a late picker resolution after the sender cancels never completes a transfer", async ({ browser }) => {
  test.setTimeout(90_000);
  const { a, b } = await pair(browser, { pickerDelay: 1500, writeDelay: 4, closeDelay: 0 });
  const errors: string[] = [];
  watch(a.page, errors); watch(b.page, errors);
  try {
    await offer(a.page, b.page, Buffer.from("late"), "late.bin");
    await accept(b.page);
    await expect(b.page.getByTestId("picker-pending")).toBeVisible();
    await a.page.getByRole("button", { name: "لغو انتقال" }).click();
    await expect(a.page.getByTestId("transfer-status")).toHaveText("انتقال لغو شد");
    // Let the picker resolve after the offer is already gone.
    await b.page.waitForTimeout(2200);
    await expect(b.page.getByText("انتقال کامل شد")).toHaveCount(0);
    await expect(b.page.getByTestId("disk-saved")).toHaveCount(0);
    await expect(b.page.getByRole("dialog")).not.toBeVisible();
    const record = await readRecord(b.page);
    expect(record.stored).toBe(0);
    expect(errors).toEqual([]);

    await offer(a.page, b.page, Buffer.from("recovered"), "recovered.bin");
    await accept(b.page);
    await expect(b.page.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
    expect(await storedDigest(b.page)).toBe(sha(Buffer.from("recovered")));
  } finally { await a.context.close(); await b.context.close(); }
});

test("createWritable failure is visible and rejects the pending offer", async ({ browser }) => {
  const { a, b } = await pair(browser, { pickerDelay: 100, failCreate: true });
  try {
    await offer(a.page, b.page, Buffer.from("no writable"), "nowrite.bin");
    await accept(b.page);
    await expect(b.page.getByTestId("alert")).toBeVisible();
    await expect(a.page.getByTestId("transfer-status")).toHaveText(/لغو|ناموفق/);
    await expect(b.page.getByText("انتقال کامل شد")).toHaveCount(0);
    await expect(b.page.getByRole("dialog")).not.toBeVisible();
    const record = await readRecord(b.page);
    expect(record.createCalls).toBe(1);
    expect(record.writeCalls).toBe(0);
  } finally { await a.context.close(); await b.context.close(); }
});

test("a failed write is reported and never marked complete", async ({ browser }) => {
  const { a, b } = await pair(browser, { pickerDelay: 50, writeDelay: 10, failWriteAt: 2 });
  try {
    await offer(a.page, b.page, randomBytes(300 * 1024), "write-fail.bin");
    await accept(b.page);
    await expect(b.page.getByTestId("transfer-status")).toHaveText("انتقال ناموفق");
    await expect(b.page.getByTestId("alert")).toBeVisible();
    await expect(a.page.getByTestId("transfer-status")).toHaveText(/لغو|ناموفق/);
    await expect(b.page.getByText("انتقال کامل شد")).toHaveCount(0);
    await expect(b.page.getByTestId("disk-saved")).toHaveCount(0);
    await expect(b.page.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow", "100");
  } finally { await a.context.close(); await b.context.close(); }
});

test("a failed close is reported instead of a saved confirmation", async ({ browser }) => {
  const { a, b } = await pair(browser, { pickerDelay: 50, writeDelay: 4, closeDelay: 400, failClose: true });
  try {
    await offer(a.page, b.page, randomBytes(200 * 1024), "close-fail.bin");
    await accept(b.page);
    await expect(b.page.getByTestId("transfer-status")).toHaveText(/در حال نهایی/);
    await expect(b.page.getByTestId("transfer-status")).toHaveText("انتقال ناموفق");
    await expect(b.page.getByTestId("alert")).toBeVisible();
    await expect(a.page.getByTestId("transfer-status")).toHaveText(/لغو|ناموفق/);
    await expect(b.page.getByText("انتقال کامل شد")).toHaveCount(0);
    await expect(b.page.getByTestId("disk-saved")).toHaveCount(0);
    await expect(b.page.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow", "100");
  } finally { await a.context.close(); await b.context.close(); }
});

test("cancelling during a delayed disk write stops the stream", async ({ browser }) => {
  test.setTimeout(90_000);
  const { a, b } = await pair(browser, { pickerDelay: 50, writeDelay: 150 });
  try {
    await offer(a.page, b.page, randomBytes(1024 * 1024), "cancel-midwrite.bin");
    await accept(b.page);
    await expect.poll(async () => (await readRecord(b.page)).stored).toBeGreaterThan(0);
    await b.page.getByRole("button", { name: "لغو انتقال" }).click();
    await expect(b.page.getByTestId("transfer-status")).toHaveText("انتقال لغو شد");
    await expect(a.page.getByTestId("transfer-status")).toHaveText("انتقال لغو شد");
    await expect(b.page.getByText("انتقال کامل شد")).toHaveCount(0);
    await expect(b.page.getByTestId("disk-saved")).toHaveCount(0);
    const stored = (await readRecord(b.page)).stored;
    await b.page.waitForTimeout(700);
    expect((await readRecord(b.page)).stored).toBeLessThanOrEqual(stored + 1);
  } finally { await a.context.close(); await b.context.close(); }
});

test("oversize offer metadata is refused automatically when no disk API exists (metadata test)", async ({ browser }) => {
  test.setTimeout(90_000);
  // No gigabytes are allocated: the sender rewrites the offer metadata to 3 GiB on the wire.
  const { a, b } = await pair(browser, null, 3 * 1024 ** 3);
  const errors: string[] = [];
  watch(a.page, errors); watch(b.page, errors);
  try {
    expect(MAX_MEMORY_FILE_SIZE).toBeLessThan(3 * 1024 ** 3);
    await a.page.getByLabel("انتخاب فایل برای ارسال").setInputFiles({ name: "huge-metadata.bin", mimeType: "application/octet-stream", buffer: Buffer.from("tiny") });
    await a.page.getByRole("button", { name: "ارسال فایل", exact: true }).click();
    // The receiver must refuse without any user action, and the aborted offer must reach the sender.
    await expect(b.page.getByTestId("alert")).toBeVisible({ timeout: 10_000 });
    await expect(b.page.getByRole("dialog")).not.toBeVisible();
    await expect(b.page.getByText("انتقال کامل شد")).toHaveCount(0);
    await expect(a.page.getByTestId("transfer-status")).toHaveText(/لغو|ناموفق/, { timeout: 20_000 });
    expect(errors).toEqual([]);
  } finally { await a.context.close(); await b.context.close(); }
});
