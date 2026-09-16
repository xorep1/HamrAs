import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

// Two micro-measurements that separate the two suspects from the phase budget:
//  (1) does reading the File cost scale with bytes or with the number of slice calls?
//  (2) what is the raw DataChannel ceiling between two peer connections in one browser?
const MIB = 1024 * 1024;

test("file read cost: per call or per byte", async ({ page }) => {
  const dir = "/tmp/hamras-bench";
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/micro-64m.bin`;
  writeFileSync(path, Buffer.alloc(64 * MIB));

  await page.goto("/");
  await expect(page.getByRole("status").first()).toContainText("متصل");
  // A private input keeps the File object addressable: the app clears its own input after reading.
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "micro-input";
    document.body.appendChild(input);
  });
  await page.setInputFiles("#micro-input", path);

  const result = await page.evaluate(async () => {
    const file = (document.querySelector("#micro-input") as HTMLInputElement).files![0];
    const out: string[] = [];
    for (const size of [64 * 1024, 512 * 1024, 4 * 1024 * 1024]) {
      const limit = 16 * 1024 * 1024;
      const started = performance.now();
      let calls = 0;
      for (let offset = 0; offset < limit; offset += size) {
        await file.slice(offset, offset + size).arrayBuffer();
        calls += 1;
      }
      const ms = performance.now() - started;
      out.push(`${(size / 1024).toFixed(0)} KiB reads: ${calls} calls, ${ms.toFixed(0)}ms, ${(limit / 1024 / 1024 / (ms / 1000)).toFixed(1)} MiB/s, ${(ms / calls).toFixed(2)} ms/call`);
    }
    // Also: streaming the same file through its native reader, for comparison.
    const started = performance.now();
    let bytes = 0;
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes >= 16 * 1024 * 1024) break;
    }
    const streamMs = performance.now() - started;
    out.push(`file.stream(): ${(bytes / 1024 / 1024).toFixed(1)} MiB in ${streamMs.toFixed(0)}ms, ${(bytes / 1024 / 1024 / (streamMs / 1000)).toFixed(1)} MiB/s`);
    return out;
  });
  for (const line of result) console.log(`[micro] ${line}`);
});

test("raw data channel ceiling in one browser", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const MIB = 1024 * 1024;
    const a = new RTCPeerConnection({ iceServers: [] });
    const b = new RTCPeerConnection({ iceServers: [] });
    a.onicecandidate = (event) => { if (event.candidate) void b.addIceCandidate(event.candidate); };
    b.onicecandidate = (event) => { if (event.candidate) void a.addIceCandidate(event.candidate); };
    const channel = a.createDataChannel("bench", { ordered: true });
    channel.binaryType = "arraybuffer";
    let received = 0;
    let receiverQueue: ArrayBuffer[] = [];
    b.ondatachannel = ({ channel: remote }) => {
      remote.binaryType = "arraybuffer";
      remote.onmessage = (event) => { received += (event.data as ArrayBuffer).byteLength; receiverQueue.push(event.data as ArrayBuffer); if (receiverQueue.length > 8) receiverQueue = []; };
    };
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription!);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("channel did not open")), 15_000);
      channel.onopen = () => { clearTimeout(timer); resolve(); };
    });

    const results: string[] = [`negotiated maxMessageSize: ${a.sctp?.maxMessageSize ?? "unknown"} bytes`];
    for (const size of [64 * 1024, 128 * 1024, 256 * 1024]) {
      const cap = 8 * MIB;
      channel.bufferedAmountLowThreshold = cap / 4;
      const buffer = new ArrayBuffer(size);
      const started = performance.now();
      const before = received;
      let sent = 0;
      let errors = 0;
      let maxBuffered = 0;
      while (performance.now() - started < 2000) {
        if (channel.bufferedAmount > cap) {
          await new Promise<void>((resolve) => {
            const done = () => { channel.removeEventListener("bufferedamountlow", done); resolve(); };
            channel.addEventListener("bufferedamountlow", done);
            setTimeout(done, 100);
          });
          continue;
        }
        // A short synchronous burst, then a task turn so bufferedAmount refreshes: sending in one
        // unbounded loop overruns the 16 MiB send queue because bufferedAmount updates asynchronously.
        for (let i = 0; i < 8 / (size / (64 * 1024)) && channel.bufferedAmount <= cap; i += 1) {
          try { channel.send(buffer); sent += size; } catch { errors += 1; break; }
        }
        maxBuffered = Math.max(maxBuffered, channel.bufferedAmount);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const ms = performance.now() - started;
      results.push(`message ${(size / 1024).toFixed(0)} KiB: ${(sent / MIB / (ms / 1000)).toFixed(1)} MiB/s queued, ${((received - before) / MIB / (ms / 1000)).toFixed(1)} MiB/s delivered, peak bufferedAmount ${(maxBuffered / MIB).toFixed(2)} MiB, queue-full errors ${errors}`);
    }
    a.close(); b.close();
    return results;
  });
  for (const line of result) console.log(`[micro] ${line}`);
});
