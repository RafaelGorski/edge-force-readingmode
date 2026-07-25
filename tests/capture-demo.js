// Demo capture: launches real Edge with the extension, activates reading mode on
// both the local fixture and the live LinkedIn article, and saves screenshots.
// Usage: node tests/capture-demo.js [outputDir]
const os = require("os");
const fs = require("fs");
const path = require("path");
const { chromium } = require("@playwright/test");

const EXTENSION_PATH = path.join(__dirname, "..", "extension");
const OUT = process.argv[2] || path.join(__dirname, "..", "screenshots");
const FIXTURE_URL = "http://127.0.0.1:5178/blocked-article.html";
const LINKEDIN_URL =
  "https://www.linkedin.com/pulse/dark-arts-skill-engineering-paul-bakaus-hwcic/";

async function activate(page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page
      .evaluate(() => document.dispatchEvent(new CustomEvent("force-reading-mode:on")))
      .catch(() => {});
    const ok = await page
      .evaluate(() => !!document.getElementById("force-reading-mode-host"))
      .catch(() => false);
    if (ok) return true;
    await page.waitForTimeout(350);
  }
  return false;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "frm-demo-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "msedge",
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      "--headless=new",
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.setViewportSize({ width: 1280, height: 900 });

  // 1) Local fixture (native reader blocked).
  await page.goto(FIXTURE_URL, { waitUntil: "load" });
  await page.screenshot({ path: path.join(OUT, "01-fixture-before.png") });
  await activate(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, "02-fixture-reading-mode.png") });
  console.log("Saved fixture screenshots.");

  // 2) Live LinkedIn article.
  try {
    await page.goto(LINKEDIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3500);
    await page.screenshot({ path: path.join(OUT, "03-linkedin-before.png") });
    const ok = await activate(page, 12000);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, "04-linkedin-reading-mode.png") });
    const info = await page.evaluate(() => {
      const host = document.getElementById("force-reading-mode-host");
      const sr = host && host.shadowRoot;
      const c = sr && sr.querySelector(".frm-content");
      const t = sr && sr.querySelector(".frm-title");
      return {
        active: !!host && host.getAttribute("data-frm-active") === "true",
        title: t ? t.textContent.trim() : "",
        chars: c ? c.innerText.trim().length : 0,
        images: c ? c.querySelectorAll("img").length : 0,
      };
    });
    console.log("LinkedIn:", ok ? "activated" : "not activated", JSON.stringify(info));
  } catch (e) {
    console.log("LinkedIn capture skipped:", e.message);
  }

  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log("Screenshots written to", OUT);
})();
