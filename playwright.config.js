const { defineConfig } = require("@playwright/test");

// Reading mode is verified by driving real Microsoft Edge with the unpacked
// extension loaded. Extensions require a persistent context, created inside the
// spec's custom fixture, so no `projects` browser config is needed here.
module.exports = defineConfig({
  testDir: "./tests",
  timeout: 90000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  webServer: {
    command: "node tests/server.js",
    url: "http://127.0.0.1:5178/blocked-article.html",
    reuseExistingServer: true,
    timeout: 30000,
  },
});
