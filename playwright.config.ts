import { defineConfig, devices } from "@playwright/test";

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
    url: "http://127.0.0.1:8799/examples/visual.html",
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
