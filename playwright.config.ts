import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    browserName: "chromium",
    viewport: { width: 1440, height: 1080 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node server.mjs --production",
    url: "http://127.0.0.1:3100",
    env: { PORT: "3100", NEXT_TELEMETRY_DISABLED: "1", HOST_UPLOAD_DIR: "tests/.uploads" },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
