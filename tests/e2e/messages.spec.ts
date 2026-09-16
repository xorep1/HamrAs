import { test, expect, type Browser, type Page } from "@playwright/test";
import { PASSWORD } from "./settings";

// Two text features are covered here: a private message relayed on the signaling socket (nothing is
// stored) and a text saved on the host, which stays visible on the page for everyone on the LAN.

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

async function named(page: Page, name: string) {
  await expect(page.getByRole("status").first()).toContainText("متصل");
  await page.getByRole("button", { name: "تغییر نام دستگاه" }).click();
  await page.getByRole("textbox", { name: "نام دستگاه" }).fill(name);
  await page.getByRole("button", { name: "ذخیره نام" }).click();
}

async function pair(browser: Browser) {
  const sender = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  const receiver = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
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

test.afterEach(async ({ request }) => {
  const { messages } = await (await request.get("/api/host/messages")).json();
  for (const message of messages) await request.delete(`/api/host/messages/${message.id}`, { headers: { "x-hamras-password": PASSWORD } });
});

test("a saved text is public, copyable and still password-gated for writing", async ({ page, request }) => {
  test.setTimeout(90_000);
  const draft = "متن آزمایشی\nخط دوم با <b>تگ</b> و ایموجی ✅";
  await page.goto("/");
  await expect(page.getByTestId("host-panel")).toBeVisible();

  await page.getByLabel("متن برای ذخیره روی هاست").fill(draft);
  // Like the file uploader, the save button stays disabled until a password is present at all.
  await expect(page.getByTestId("host-text-save")).toBeDisabled();
  await page.getByLabel("رمز آپلود").fill("0000");
  await page.getByTestId("host-text-save").click();
  await expect(page.getByTestId("host-error")).toContainText("رمز");
  await expect(page.getByTestId("host-text-row")).toHaveCount(0);

  await page.getByLabel("رمز آپلود").fill(PASSWORD);
  const blockedResponse = page.waitForResponse((response) => response.url().endsWith("/api/host/messages") && response.request().method() === "POST");
  await page.getByTestId("host-text-save").click();
  expect((await blockedResponse).status()).toBe(429);
  await expect(page.getByTestId("host-error")).toContainText("ثانیه");
  await expect.poll(async () => (await request.post("/api/host/session", {
    headers: { "x-hamras-password": PASSWORD },
  })).status(), { timeout: 65_000, intervals: [1000] }).toBe(200);
  await page.getByTestId("host-text-save").click();
  await expect(page.getByTestId("host-text-row")).toHaveCount(1);
  // Markup in a stored text is displayed as typed, never as active content.
  await expect(page.getByTestId("host-text-row")).toContainText("خط دوم با <b>تگ</b> و ایموجی ✅");

  // A reader with no credentials at all sees the same text, exactly as it was written.
  const listing = await request.get("/api/host/messages");
  expect(listing.ok()).toBe(true);
  expect((await listing.json()).messages[0].text).toBe(draft);

  await page.getByTestId("host-text-copy").click();
  await expect(page.getByTestId("host-text-copy")).toContainText("کپی شد");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(draft);

  // Deleting is a writing path, so it needs the password too.
  await page.getByTestId("host-text-delete").click();
  await expect(page.getByTestId("host-text-row")).toHaveCount(0);
});

test("a private message reaches the chosen device, reports delivery and copies on both sides", async ({ browser }) => {
  const { a, b, sender, receiver } = await pair(browser);
  const text = "سلام از رایانه\nسطر دوم";

  // Nothing can be sent before a draft exists.
  await expect(a.getByTestId("chat-send")).toBeDisabled();
  const composer = a.getByRole("textbox", { name: "متن پیام", exact: true });
  await composer.fill(text);
  await a.getByTestId("chat-send").click();

  await expect(b.getByTestId("chat-row")).toHaveCount(1);
  await expect(b.getByTestId("chat-row")).toContainText("سلام از رایانه");
  // The sender hears a relay confirmation, not a read receipt.
  await expect(a.getByTestId("chat-row")).toContainText("ارسال شد");
  await expect(composer).toHaveValue("");

  await b.getByTestId("chat-copy").click();
  expect(await b.evaluate(() => navigator.clipboard.readText())).toBe(text);

  // The narrow viewport keeps the new panels reachable without horizontal overflow, and the page
  // stays scrollable from the header down to the footer.
  expect(await b.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await b.getByTestId("chat-panel").scrollIntoViewIfNeeded();
  await expect(b.getByTestId("chat-panel")).toBeInViewport();
  await b.getByTestId("host-text-save").scrollIntoViewIfNeeded();
  await expect(b.getByTestId("host-text-save")).toBeInViewport();
  await b.locator("footer").scrollIntoViewIfNeeded();
  await expect(b.locator("footer")).toBeInViewport();
  await b.evaluate(() => window.scrollTo(0, 0));
  await expect(b.locator("header")).toBeInViewport();

  await sender.close();
  await receiver.close();
});
