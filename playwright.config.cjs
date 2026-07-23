const { defineConfig } = require("@playwright/test");

// These tests always start an in-process, file-backed test server. There is
// intentionally no E2E_BASE_URL escape hatch: this command must never point at
// the public production application.
module.exports = defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  outputDir: "test-results/playwright",
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  }
});