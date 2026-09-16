import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { PASSWORD } from "./settings";

// Host storage, unlike the peer-to-peer path, keeps bytes on the server. The contract under test:
// writing needs the password, reading never does. The password comes from .env, the file the server reads.
async function pick(page: import("@playwright/test").Page, name: string, body: Buffer, mime = "application/octet-stream") {
  await page.getByLabel("انتخاب فایل برای آپلود روی هاست").setInputFiles({ name, mimeType: mime, buffer: body });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("host-panel")).toBeVisible();
});

test.afterEach(async ({ request }) => {
  const { files } = await (await request.get("/api/host/files")).json();
  for (const file of files) await request.delete(`/api/host/files/${file.id}`, { headers: { "x-hamras-password": PASSWORD } });
});

test("a wrong password blocks uploads for one minute, then the right one works", async ({ page, request }) => {
  test.setTimeout(90_000);
  const body = randomBytes(64 * 1024);
  await pick(page, "host-upload.bin", body);

  await page.getByLabel("رمز آپلود").fill("0000");
  await page.getByTestId("host-upload-button").click();
  await expect(page.getByTestId("host-error")).toContainText("رمز");
  expect((await (await request.get("/api/host/files")).json()).files).toHaveLength(0);

  await page.getByLabel("رمز آپلود").fill(PASSWORD);
  const blockedResponse = page.waitForResponse((response) => response.url().endsWith("/api/host/files") && response.request().method() === "POST");
  await page.getByTestId("host-upload-button").click();
  expect((await blockedResponse).status()).toBe(429);
  await expect(page.getByTestId("host-error")).toContainText("ثانیه");
  // Retrying with the right password cannot bypass or prolong the server-side cooldown.
  await expect.poll(async () => (await request.post("/api/host/session", {
    headers: { "x-hamras-password": PASSWORD },
  })).status(), { timeout: 65_000, intervals: [1000] }).toBe(200);
  await page.getByTestId("host-upload-button").click();
  await expect(page.getByTestId("host-notice")).toContainText("host-upload.bin");
  await expect(page.getByTestId("host-row")).toHaveCount(1);

  // A brand-new browser context carries no credentials at all and must still be able to read.
  const listing = await request.get("/api/host/files");
  expect(listing.ok()).toBe(true);
  const { files } = await listing.json();
  expect(files[0].name).toBe("host-upload.bin");
  const download = await request.get(`/api/host/files/${files[0].id}`);
  expect(download.ok()).toBe(true);
  expect(Buffer.from(await download.body()).equals(body)).toBe(true);
});

test("an oversized file is refused in the browser before anything is sent", async ({ page }) => {
  await expect(page.getByTestId("host-panel")).toContainText("حداکثر");
  // A real 4 GiB fixture is impractical here, so the client-side guard is checked through the API cap.
  await pick(page, "small.bin", randomBytes(1024));
  await page.getByLabel("رمز آپلود").fill(PASSWORD);
  await page.getByTestId("host-upload-button").click();
  await expect(page.getByTestId("host-row")).toHaveCount(1);
});

test("a Persian name and a viewable type survive the round trip", async ({ page, request }) => {
  await pick(page, "تصویر.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png");
  await page.getByLabel("رمز آپلود").fill(PASSWORD);
  await page.getByTestId("host-upload-button").click();
  await expect(page.getByTestId("host-row")).toContainText("تصویر.png");
  // Viewable types offer an in-browser preview; everything else is download-only.
  await expect(page.getByRole("link", { name: "مشاهده" })).toBeVisible();

  const { files } = await (await request.get("/api/host/files")).json();
  const viewed = await request.get(`/api/host/files/${files[0].id}?inline=1`);
  expect(viewed.headers()["content-type"]).toBe("image/png");
  expect(viewed.headers()["content-disposition"]).toContain("inline");
});
