import { defineConfig, devices } from "@playwright/test";

// PW_PORT lets parallel checkouts run browser suites without sharing a server.
const port = Number(process.env.PW_PORT || 8799);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}{ext}",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    deviceScaleFactor: 1,
    viewport: { width: 1100, height: 620 },
    locale: "en-US",
    timezoneId: "UTC",
    launchOptions: {
      args: ["--font-render-hinting=none", "--disable-lcd-text"],
    },
  },
  webServer: {
    command: "node tests/static-server.mjs",
    url: `${baseURL}/examples/visual.html`,
    env: { PORT: String(port) },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  expect: {
    toHaveScreenshot: {
      // Chromium rasterisation differs slightly across OS font engines.
      maxDiffPixelRatio: 0.04,
      animations: "disabled",
    },
  },
});
