import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FILE_SIZE, MAX_MESSAGE_LENGTH, cleanName, isPrivateAddress, percent, safeFilename, validFile, validId, validMessageText, validSignal } from "../src/lib/protocol.mjs";

test("file validation accepts empty and maximum-sized files", () => {
  assert.ok(validFile({ name: "empty", mime: "", size: 0 }));
  assert.ok(validFile({ name: "max.bin", mime: "application/octet-stream", size: MAX_FILE_SIZE }));
  for (const size of [-1, 0.5, NaN, Infinity, MAX_FILE_SIZE + 1, "100"]) {
    assert.ok(!validFile({ name: "invalid", mime: "", size }));
  }
  for (const file of [null, {}, { name: "", mime: "", size: 0 }, { name: "x".repeat(256), mime: "", size: 1 }]) assert.ok(!validFile(file));
});

test("IDs, names and download filenames are bounded and safe", () => {
  assert.ok(validId("12345678-abcd"));
  assert.ok(!validId("../../invalid"));
  assert.ok(!validId("a".repeat(65)));
  assert.equal(cleanName("  Test\u0000\u202e  "), "Test");
  assert.equal(cleanName("x".repeat(100)).length, 32);
  assert.equal(safeFilename("../x\\y\u0000.bin"), ".._x_y_.bin");
});

test("only local address classes pass LAN filtering", () => {
  for (const address of ["::1", "127.0.0.1", "::ffff:192.168.1.4", "10.2.3.4", "172.16.0.2", "172.31.255.1", "169.254.2.3", "fe80::1%eth0", "fd00::2"]) assert.ok(isPrivateAddress(address), address);
  for (const address of ["8.8.8.8", "172.32.0.1", "172.15.1.2", "2001:4860::1", ""]) assert.ok(!isPrivateAddress(address), address);
});

test("progress is bounded; zero-byte completion needs receipt", () => {
  assert.equal(percent(0, 0), 0);
  assert.equal(percent(1, 3), 33);
  assert.equal(percent(120, 100), 100);
  assert.equal(percent(-5, 100), 0);
});

test("message text is bounded, must carry content, and is never rewritten", () => {
  assert.ok(validMessageText("سلام"));
  assert.ok(validMessageText("line one\nline two"));
  assert.ok(validMessageText("  leading and trailing  "));
  assert.ok(validMessageText("a".repeat(MAX_MESSAGE_LENGTH)));
  assert.ok(!validMessageText(""));
  assert.ok(!validMessageText("   \n\t  "));
  assert.ok(!validMessageText("a".repeat(MAX_MESSAGE_LENGTH + 1)));
  // An emoji is two UTF-16 units, so the cap is measured the same way the wire stores it.
  assert.ok(!validMessageText("\u{1F600}".repeat(MAX_MESSAGE_LENGTH)));
  assert.ok(!validMessageText(null));
  assert.ok(!validMessageText(42));
  // The validator only inspects text; preserving it is the store's job, so nothing may be trimmed.
  const exact = "  خط اول\n\n<b>تگ</b> & \"نقل قول\"   ";
  assert.ok(validMessageText(exact));
  assert.equal(exact, "  خط اول\n\n<b>تگ</b> & \"نقل قول\"   ");
});

test("signal validation rejects invalid and oversized payloads", () => {
  assert.ok(validSignal({ description: { type: "offer", sdp: "v=0" } }));
  assert.ok(validSignal({ candidate: { candidate: "candidate:123", sdpMid: "0", sdpMLineIndex: 0 } }));
  assert.ok(!validSignal({ description: { type: "rollback", sdp: "" } }));
  assert.ok(!validSignal({ description: { type: "offer", sdp: "x".repeat(24_001) } }));
  assert.ok(!validSignal({ candidate: { candidate: "x", sdpMLineIndex: "0" } }));
  assert.ok(!validSignal(null));
});
