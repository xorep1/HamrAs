import { defineConfig } from "@playwright/test";

// Opt-in throughput harness. Not part of the default suite (testDir is ./tests/e2e):
//   npx playwright test -c playwright.bench.config.ts
export default defineConfig({
  testDir: "./tests/bench",
  fullyParallel: false,
  workers: 1,
  timeout: 900_000,
  expect: { timeout: 120_000 },
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    browserName: "chromium",
    viewport: { width: 1440, height: 1080 },
  },
  webServer: {
    command: "node server.mjs --production",
    url: "http://127.0.0.1:3100",
    env: { PORT: "3100", NEXT_TELEMETRY_DISABLED: "1" },
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
