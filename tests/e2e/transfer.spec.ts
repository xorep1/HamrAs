import { test, expect, type Browser, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { WebSocket } from "ws";

// Chromium treats localhost as a trusted secure context, so showSaveFilePicker exists and a
// receiver click would open a real native save dialog. The intentional RAM fallback for small
// files (<= 256 MiB) must be exercised explicitly, so remove the API before any page script runs.
const removeSavePicker = () => {
  let owner: object | null = window;
  while (owner && !Object.getOwnPropertyDescriptor(owner, "showSaveFilePicker")) owner = Object.getPrototypeOf(owner);
  if (owner) { try { delete (owner as { showSaveFilePicker?: unknown }).showSaveFilePicker; } catch { /* try the own-property shadow below */ } }
  if (typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker !== "undefined") {
    Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true, writable: true });
  }
};

async function named(page: Page, name: string) {
  await expect(page.getByRole("status").first()).toContainText("متصل");
  await page.getByRole("button", { name: "تغییر نام دستگاه" }).click();
  await page.getByRole("textbox", { name: "نام دستگاه" }).fill(name);
  await page.getByRole("button", { name: "ذخیره نام" }).click();
}

async function pair(browser: Browser) {
  const sender = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const receiver = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  await sender.addInitScript(removeSavePicker);
  await receiver.addInitScript(removeSavePicker);
  const a = await sender.newPage();
  const b = await receiver.newPage();
  await a.goto("/");
  await b.goto("/");
  await named(a, "رایانهٔ فرستنده");
  await named(b, "گوشی گیرنده");
  await expect(a.getByTestId("peer-card")).toHaveCount(1);
  await expect(b.getByTestId("peer-card")).toHaveCount(1);
  await a.getByTestId("peer-card").click();
  return { a, b, sender, receiver };
}

async function offer(a: Page, b: Page, buffer: Buffer, name = "hello.bin") {
  await a.getByLabel("انتخاب فایل برای ارسال").setInputFiles({ name, mimeType: "application/octet-stream", buffer });
  await a.getByRole("button", { name: "ارسال فایل", exact: true }).click();
  await expect(b.getByRole("dialog")).toBeVisible();
  await expect(a.getByTestId("transfer-status")).toHaveText("منتظر تأیید گیرنده");
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator("footer").scrollIntoViewIfNeeded();
  await expect(page.locator("footer")).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator("header")).toBeInViewport();
}

test("desktop and mobile render accessible empty states", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("status").first()).toContainText("متصل");
  await expect(page.getByRole("button", { name: "ارسال فایل", exact: true })).toBeDisabled();
  await noOverflow(page);
  await page.screenshot({ path: "artifacts/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await noOverflow(page);
  await page.getByRole("button", { name: "راهنمای اتصال" }).click();
  await expect(page.getByRole("region", { name: "راهنمای اتصال" })).toBeVisible();
  await noOverflow(page);
  await page.getByRole("button", { name: "بستن راهنما" }).click();
  await page.screenshot({ path: "artifacts/mobile.png", fullPage: true });
});

test("direct transfer requires consent and saves identical bytes", async ({ browser }) => {
  const { a, b, sender, receiver } = await pair(browser);
  try {
    expect(await b.evaluate(() => typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker)).toBe("undefined");
    const errors: string[] = [];
    a.on("pageerror", (error) => errors.push(error.message));
    b.on("pageerror", (error) => errors.push(error.message));
    const data = randomBytes(8 * 1024 * 1024 + 11);
    await offer(a, b, data, "گزارش-آزمایش.bin");
    await expect(a.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    await noOverflow(b);
    await b.screenshot({ path: "artifacts/receive-request.png", fullPage: true });
    await b.getByRole("button", { name: "پذیرفتن و دریافت" }).click();
    await expect(b.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
    await expect(a.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
    await expect(a.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    await expect(b.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    await expect(b.getByTestId("transfer-mode")).toContainText("حافظه");
    await expect(b.getByTestId("disk-saved")).toHaveCount(0);
    const downloadEvent = b.waitForEvent("download");
    await b.getByRole("link", { name: "ذخیرهٔ فایل" }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe("گزارش-آزمایش.bin");
    const stream = await download.createReadStream();
    const hash = createHash("sha256");
    for await (const chunk of stream!) hash.update(chunk);
    expect(hash.digest("hex")).toBe(createHash("sha256").update(data).digest("hex"));
    await noOverflow(a);
    await noOverflow(b);
    await a.screenshot({ path: "artifacts/transfer-desktop.png", fullPage: true });
    await b.screenshot({ path: "artifacts/transfer-mobile.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally { await sender.close(); await receiver.close(); }
});

test("zero-byte files complete and another transfer can follow", async ({ browser }) => {
  const { a, b, sender, receiver } = await pair(browser);
  try {
    for (const data of [Buffer.alloc(0), Buffer.from("Second transfer")]) {
      await offer(a, b, data, "empty-or-small.txt");
      await b.getByRole("button", { name: "پذیرفتن و دریافت" }).click();
      await expect(a.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
      await expect(b.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
      await expect(b.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    }
  } finally { await sender.close(); await receiver.close(); }
});

test("receiver rejection, sender cancellation and disconnect are handled", async ({ browser }) => {
  const { a, b, sender, receiver } = await pair(browser);
  try {
    await offer(a, b, Buffer.from("reject"));
    await b.getByRole("button", { name: "رد درخواست" }).click();
    await expect(a.getByTestId("transfer-status")).toHaveText("انتقال لغو شد");
    await offer(a, b, Buffer.from("cancel"));
    await a.getByRole("button", { name: "لغو انتقال" }).click();
    await expect(b.getByRole("dialog")).not.toBeVisible();
    await expect(a.getByTestId("transfer-status")).toHaveText("انتقال لغو شد");
    await offer(a, b, Buffer.from("disconnect"));
    await b.close();
    await expect(a.getByTestId("transfer-status")).toHaveText("انتقال لغو شد");
    await expect(a.getByTestId("peer-card")).toHaveCount(0);
  } finally { await sender.close(); await receiver.close(); }
});

test("intermediate progress, receiver cancellation and recovery work", async ({ browser }) => {
  const { a, b, sender, receiver } = await pair(browser);
  try {
    await a.evaluate(() => {
      const original = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = async function () {
        await new Promise((resolve) => setTimeout(resolve, 18));
        return original.call(this);
      };
    });
    await offer(a, b, randomBytes(4 * 1024 * 1024));
    await b.getByRole("button", { name: "پذیرفتن و دریافت" }).click();
    for (const page of [a, b]) {
      await expect.poll(async () => Number(await page.getByRole("progressbar").getAttribute("aria-valuenow"))).toBeGreaterThan(0);
      expect(Number(await page.getByRole("progressbar").getAttribute("aria-valuenow"))).toBeLessThan(100);
    }
    await b.getByRole("button", { name: "لغو انتقال" }).click();
    await expect(a.getByTestId("transfer-status")).toHaveText("انتقال لغو شد");
    await expect(b.getByTestId("transfer-status")).toHaveText("انتقال لغو شد");
    await expect(b.getByRole("link", { name: "ذخیرهٔ فایل" })).toHaveCount(0);
    await offer(a, b, Buffer.from("Recovery"));
    await b.getByRole("button", { name: "پذیرفتن و دریافت" }).click();
    await expect(a.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
    await expect(b.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
  } finally { await sender.close(); await receiver.close(); }
});

test("a broken data channel is reported as a failure, not a cancellation", async ({ browser }) => {
  const { a, b, sender, receiver } = await pair(browser);
  try {
    await a.evaluate(() => {
      const original = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = async function () {
        await new Promise((resolve) => setTimeout(resolve, 18));
        return original.call(this);
      };
    });
    await b.evaluate(() => {
      const Original = window.RTCPeerConnection;
      (window as unknown as { __connections: RTCPeerConnection[] }).__connections = [];
      window.RTCPeerConnection = class extends Original {
        constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
          super(...args);
          (window as unknown as { __connections: RTCPeerConnection[] }).__connections.push(this);
        }
      } as unknown as typeof RTCPeerConnection;
    });
    await offer(a, b, randomBytes(4 * 1024 * 1024));
    await b.getByRole("button", { name: "پذیرفتن و دریافت" }).click();
    await expect.poll(async () => Number(await a.getByRole("progressbar").getAttribute("aria-valuenow"))).toBeGreaterThan(0);
    await b.evaluate(() => (window as unknown as { __connections: RTCPeerConnection[] }).__connections.forEach((pc) => pc.close()));
    await expect(a.getByTestId("transfer-status")).toHaveText("انتقال ناموفق");
    await expect(b.getByTestId("transfer-status")).toHaveText("انتقال ناموفق");
    await expect(b.getByRole("link", { name: "ذخیرهٔ فایل" })).toHaveCount(0);
    await expect(b.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow", "100");
    await offer(a, b, Buffer.from("After failure"));
    await b.getByRole("button", { name: "پذیرفتن و دریافت" }).click();
    await expect(a.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
    await expect(b.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
  } finally { await sender.close(); await receiver.close(); }
});

test("peer list recovers after signaling network interruption", async ({ browser }) => {
  const { a, b, sender, receiver } = await pair(browser);
  try {
    await receiver.setOffline(true);
    await expect(a.getByTestId("peer-card")).toHaveCount(0);
    await receiver.setOffline(false);
    await expect(b.getByRole("status").first()).toContainText("متصل");
    await expect(a.getByTestId("peer-card")).toHaveCount(1);
    await expect(a.getByTestId("peer-card")).toContainText("گوشی گیرنده");
  } finally { await sender.close(); await receiver.close(); }
});

test("HTTP LAN address works without secure-context-only UUID APIs", async ({ page, browser }) => {
  const address = Object.values(networkInterfaces()).flat().find((item) => item && !item.internal && item.family === "IPv4")?.address;
  test.skip(!address, "No LAN interface available");
  await page.goto(`http://${address}:3100`);
  await expect(page.getByRole("status").first()).toContainText("متصل");
  expect(await page.evaluate(() => typeof RTCPeerConnection)).toBe("function");
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  const receiver = await browser.newContext();
  try {
    const other = await receiver.newPage();
    await other.goto(`http://${address}:3100`);
    await expect(page.getByTestId("peer-card")).toHaveCount(1);
    await page.getByTestId("peer-card").click();
    await offer(page, other, Buffer.from("LAN HTTP transfer"));
    await other.getByRole("button", { name: "پذیرفتن و دریافت" }).click();
    await expect(page.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
    await expect(other.getByTestId("transfer-status")).toHaveText("انتقال کامل شد");
  } finally { await receiver.close(); }
});

test("host filtering and WebSocket origin checks block cross-site access", async ({ request }) => {
  const response = await request.get("/", { headers: { Host: "attacker.invalid:3100" } });
  expect(response.status()).toBe(403);
  const rejected = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket("ws://127.0.0.1:3100/signal", { origin: "http://attacker.invalid" });
    socket.on("open", () => { socket.close(); resolve(false); });
    socket.on("error", () => resolve(true));
  });
  expect(rejected).toBe(true);
});

test("GiB limit, RAM fallback note and TLS guidance are visible; oversize files are refused", async ({ browser }) => {
  const memory = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const disk = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  await memory.addInitScript(removeSavePicker);
  const page = await memory.newPage();
  const direct = await disk.newPage();
  try {
    await page.goto("/");
    await expect(page.getByRole("status").first()).toContainText("متصل");
    // The host panel carries a limit label of its own, so the send panel is addressed explicitly.
    await expect(page.locator(".send-panel .file-limit")).toContainText("۵ گیگابایت");
    await expect(page.getByTestId("storage-note")).toContainText("حافظهٔ مرورگر");
    await expect(page.getByTestId("storage-note")).toContainText("۲۵۶ مگابایت");
    await page.getByRole("button", { name: "راهنمای اتصال" }).click();
    const help = page.getByRole("region", { name: "راهنمای اتصال" });
    await expect(help).toContainText("TLS_CERT_FILE");
    await expect(help).toContainText("TLS_KEY_FILE");
    await expect(help).toContainText("localhost");
    await expect(help).toContainText("کروم");
    await noOverflow(page);
    await page.getByRole("button", { name: "بستن راهنما" }).click();
    // Oversize selection is rejected without allocating gigabytes: spoof File.size, then drop it.
    await page.evaluate(() => {
      const file = new File([new Uint8Array(8)], "huge.bin");
      Object.defineProperty(file, "size", { value: 6 * 1024 ** 3 });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      document.querySelector(".dropzone")!.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(page.getByTestId("alert")).toContainText("۵ گیگابایت");
    // With the API available the same panel advertises direct disk saving instead of the RAM fallback.
    await direct.goto("/");
    await expect(direct.getByTestId("storage-note")).toContainText("ذخیرهٔ مستقیم روی دیسک");
    await expect(direct.locator(".send-panel .file-limit")).toContainText("۵ گیگابایت");
    await noOverflow(direct);
  } finally { await memory.close(); await disk.close(); }
});