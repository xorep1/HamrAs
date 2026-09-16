import { test, expect, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

// Loopback throughput harness. It measures the browser-to-browser data path (no NIC involved),
// so the numbers isolate code-path overhead: window sizes, per-chunk cost and write gating.
// Real LAN numbers will be lower. Run with:
//   npx playwright test -c playwright.bench.config.ts
const MIB = 1024 * 1024;
const DIR = "/tmp/hamras-bench";

function payload(name: string, bytes: number) {
  mkdirSync(DIR, { recursive: true });
  const path = `${DIR}/${name}`;
  writeFileSync(path, Buffer.alloc(bytes));
  return path;
}

// Real bytes on disk so the page reads through the same File API a file picker would use.
const FILES = {
  probe: payload("probe-32m.bin", 32 * MIB),
  large: payload("large-224m.bin", 224 * MIB),
};

type DiskRecord = { pickerCalls: number; writeCalls: number; bytes: number; closed: boolean };

const installDiskMock = (writeDelay: number) => {
  const record: DiskRecord = { pickerCalls: 0, writeCalls: 0, bytes: 0, closed: false };
  (window as unknown as { __benchDisk: DiskRecord }).__benchDisk = record;
  (window as unknown as { showSaveFilePicker: () => Promise<unknown> }).showSaveFilePicker = async () => {
    record.pickerCalls += 1;
    return {
      name: "bench.bin",
      createWritable: async () => ({
        write: async (chunk: unknown) => {
          if (writeDelay) await new Promise((resolve) => setTimeout(resolve, writeDelay));
          const size = chunk instanceof ArrayBuffer
            ? chunk.byteLength
            : typeof (chunk as Blob)?.size === "number" ? (chunk as Blob).size : 0;
          record.writeCalls += 1;
          record.bytes += size;
        },
        close: async () => { record.closed = true; },
        abort: async () => {},
        seek: async () => {},
        truncate: async () => {},
      }),
    };
  };
};

const removeSavePicker = () => {
  const owner = Object.getOwnPropertyDescriptor(window, "showSaveFilePicker") ? window : Object.getPrototypeOf(window);
  try { delete (owner as { showSaveFilePicker?: unknown }).showSaveFilePicker; } catch { /* shadow below */ }
  Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true, writable: true });
};

// In-page marks give millisecond precision without polling from the test process.
// Init scripts run before the DOM exists, so the observer attaches to `document` (never null).
const instrument = () => {
  const marks: Record<string, number> = {};
  (window as unknown as { __marks: Record<string, number> }).__marks = marks;
  const sample = () => {
    const text = document.querySelector('[data-testid="transfer-status"]')?.textContent?.trim();
    if (text && !(text in marks)) marks[text] = performance.now();
  };
  new MutationObserver(sample).observe(document, { subtree: true, childList: true, characterData: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sample, { once: true });
  else sample();
};

const marks = (page: Page) => page.evaluate(() => (window as unknown as { __marks: Record<string, number> }).__marks);
const diskRecord = (page: Page) => page.evaluate(() => (window as unknown as { __benchDisk: DiskRecord }).__benchDisk);
const perfData = (page: Page) => page.evaluate(() => (window as unknown as { __perf: Record<string, number> }).__perf);
const heap = (page: Page) => page.evaluate(() => {
  const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return memory ? memory.usedJSHeapSize : 0;
});

async function openPage(context: { newPage: () => Promise<Page> }, name: string) {
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("status").first()).toContainText("متصل");
  await page.getByRole("button", { name: "تغییر نام دستگاه" }).click();
  await page.getByRole("textbox", { name: "نام دستگاه" }).fill(name);
  await page.getByRole("button", { name: "ذخیره نام" }).click();
  return page;
}

type Run = {
  mode: "memory" | "disk";
  bytes: number;
  transferMs: number;
  totalMs: number;
  senderHeap: number;
  receiverHeap: number;
  writeCalls?: number;
  writeBytes?: number;
};

async function run(browser: Browser, mode: "memory" | "disk", file: string, bytes: number, writeDelay = 0): Promise<Run> {
  const senderContext = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const receiverContext = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  await senderContext.addInitScript(instrument);
  await receiverContext.addInitScript(instrument);
  await senderContext.addInitScript(removeSavePicker);
  if (mode === "disk") await receiverContext.addInitScript(installDiskMock, writeDelay);
  else await receiverContext.addInitScript(removeSavePicker);

  const a = await openPage(senderContext, "فرستنده");
  const b = await openPage(receiverContext, "گیرنده");
  try {
    await expect(a.getByTestId("peer-card")).toHaveCount(1);
    await a.getByTestId("peer-card").click();
    await a.getByLabel("انتخاب فایل برای ارسال").setInputFiles(file);
    await a.getByRole("button", { name: "ارسال فایل", exact: true }).click();
    await expect(b.getByRole("dialog")).toBeVisible();

    const senderHeap = await heap(a);
    const started = Date.now();
    await b.getByRole("button", { name: "پذیرفتن و دریافت" }).click();
    await expect(a.getByTestId("transfer-status")).toHaveText("انتقال کامل شد", { timeout: 600_000 });
    const totalMs = Date.now() - started;

    const senderMarks = await marks(a);
    const receiverMarks = await marks(b);
    const transferMs = (senderMarks["انتقال کامل شد"] ?? 0) - (senderMarks["در حال انتقال"] ?? 0);
    if (!(transferMs > 0)) throw new Error(`missing transfer marks: ${JSON.stringify(senderMarks)}`);

    const result: Run = {
      mode, bytes, transferMs, totalMs,
      senderHeap, receiverHeap: await heap(b),
      writeCalls: mode === "disk" ? (await diskRecord(b)).writeCalls : undefined,
      writeBytes: mode === "disk" ? (await diskRecord(b)).bytes : undefined,
    };
    const receiverTransferMs = (receiverMarks["انتقال کامل شد"] ?? 0) - (receiverMarks["در حال انتقال"] ?? 0);
    console.log(`[bench] ${mode} ${(bytes / MIB).toFixed(0)} MiB: transfer ${transferMs.toFixed(0)}ms (sender) / ${receiverTransferMs.toFixed(0)}ms (receiver), total ${totalMs}ms, ${(bytes / MIB / (transferMs / 1000)).toFixed(1)} MiB/s, receiver heap ${(result.receiverHeap / MIB).toFixed(1)} MiB, writes ${result.writeCalls ?? "-"} (${((result.writeBytes ?? 0) / MIB).toFixed(1)} MiB)`);
    const sender = await perfData(a);
    if (sender) console.log(`[bench]   sender phase budget: chunks ${sender.chunks}, slice ${sender.slice.toFixed(0)}ms, credit-wait ${sender.credit.toFixed(0)}ms, buffer-wait ${sender.buffer.toFixed(0)}ms, acks ${sender.acks}`);
    return result;
  } finally {
    await senderContext.close();
    await receiverContext.close();
  }
}

const rate = (run: Run) => run.bytes / MIB / (run.transferMs / 1000);

test("loopback throughput: memory path", async ({ browser }) => {
  test.setTimeout(900_000);
  const probe = await run(browser, "memory", FILES.probe, 32 * MIB);
  const large = await run(browser, "memory", FILES.large, 224 * MIB);
  // Two sizes: the slope removes the fixed setup cost, giving the steady-state rate.
  const slope = (large.bytes - probe.bytes) / MIB / ((large.transferMs - probe.transferMs) / 1000);
  console.log(`[bench] memory steady-state (slope): ${slope.toFixed(1)} MiB/s`);
  expect(large.receiverHeap).toBeLessThan(700 * MIB);
});

test("loopback throughput: disk path with instant writes", async ({ browser }) => {
  test.setTimeout(900_000);
  const probe = await run(browser, "disk", FILES.probe, 32 * MIB, 0);
  const large = await run(browser, "disk", FILES.large, 224 * MIB, 0);
  const slope = (large.bytes - probe.bytes) / MIB / ((large.transferMs - probe.transferMs) / 1000);
  console.log(`[bench] disk steady-state (slope): ${slope.toFixed(1)} MiB/s`);
  expect(large.writeBytes).toBe(224 * MIB);
  // The whole point of the disk path: the receiver heap must not grow with file size.
  expect(large.receiverHeap).toBeLessThan(220 * MIB);
  console.log(`[bench] disk receiver heap: ${(large.receiverHeap / MIB).toFixed(1)} MiB`);
});

test("loopback throughput: slow disk gates the sender without buffering the file", async ({ browser }) => {
  test.setTimeout(900_000);
  // Writes are coalesced into blocks, so the delay is charged per block: 60 ms per write is the slow
  // sink here. What matters is that the sender is gated by it instead of queueing the file up.
  const slow = await run(browser, "disk", FILES.probe, 32 * MIB, 60);
  console.log(`[bench] slow disk: ${rate(slow).toFixed(1)} MiB/s, receiver heap ${(slow.receiverHeap / MIB).toFixed(1)} MiB`);
  expect(slow.writeCalls).toBeGreaterThan(0);
  expect(slow.writeCalls).toBeLessThanOrEqual(32 * MIB / (64 * 1024));
  expect(slow.receiverHeap).toBeLessThan(120 * MIB);
});
