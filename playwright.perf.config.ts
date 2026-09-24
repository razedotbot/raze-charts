import { defineConfig, devices } from "@playwright/test";

// Browser benchmark config. Kept separate from playwright.config.ts so the
// visual and accessibility suites never pay for (or get flaky from) timing
// runs. Run it through `node scripts/benchmark-widget.mjs`, which builds the
// report and enforces budgets. PW_PORT keeps parallel checkouts apart; the
// default differs from the visual suite's 8799 so a running visual server is
// never reused without the isolation headers the benchmark needs.
const port = Number(process.env.PW_PORT || 8798);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/perf",
  testMatch: "**/*.bench.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // A retried timing run would hide exactly the variance budgets must see.
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    // Same surface as the visual goldens: 1100x620 CSS px at DPR 1.
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
    url: `${baseURL}/examples/benchmark.html`,
    // Cross-origin isolation gives the page 5 µs timers instead of 100 µs.
    env: { PORT: String(port), CROSS_ORIGIN_ISOLATED: "1" },
    // Reusing a server started without isolation would silently coarsen
    // every measurement, so the benchmark always owns its server.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
