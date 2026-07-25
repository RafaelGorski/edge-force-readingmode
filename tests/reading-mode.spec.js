const os = require("os");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { test: base, expect, chromium } = require("@playwright/test");

const EXTENSION_PATH = path.join(__dirname, "..", "extension");
const FIXTURE_URL = "http://127.0.0.1:5178/blocked-article.html";
const LINKEDIN_URL =
  "https://www.linkedin.com/pulse/dark-arts-skill-engineering-paul-bakaus-hwcic/";

// Load the unpacked extension into a real Microsoft Edge instance. Extensions
// require a persistent context; the modern headless mode (`--headless=new`)
// supports them without a display.
const test = base.extend({
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "frm-edge-"));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: "msedge",
      headless: false,
      args: [
        "--headless=new",
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });
    await use(context);
    await context.close();
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch (e) {
      /* best effort */
    }
  },
  page: async ({ context }, use) => {
    const page = context.pages()[0] || (await context.newPage());
    await use(page);
  },
});

// Repeatedly fire the idempotent "on" trigger until the reader overlay appears.
async function tryActivate(page, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await page
      .evaluate(() => document.dispatchEvent(new CustomEvent("force-reading-mode:on")))
      .catch(() => {});
    const present = await page
      .evaluate(() => !!document.getElementById("force-reading-mode-host"))
      .catch(() => false);
    if (present) return true;
    await page.waitForTimeout(350);
  }
  return false;
}

// Read the reader overlay's state from inside its open Shadow DOM.
async function readReaderState(page) {
  return page.evaluate(() => {
    const host = document.getElementById("force-reading-mode-host");
    if (!host) return { present: false };
    const sr = host.shadowRoot;
    const content = sr && sr.querySelector(".frm-content");
    const titleEl = sr && sr.querySelector(".frm-title");
    const imgs = content ? Array.from(content.querySelectorAll("img")) : [];
    return {
      present: true,
      active: host.getAttribute("data-frm-active") === "true",
      hasShadow: !!sr,
      title: titleEl ? titleEl.textContent.trim() : "",
      text: content ? content.innerText.trim() : "",
      imgCount: imgs.length,
      firstImgSrc: imgs.length ? imgs[0].src : "",
    };
  });
}

test("activates a reading overlay on a page that blocks the native reader", async ({ page }) => {
  await page.goto(FIXTURE_URL, { waitUntil: "load" });

  const activated = await tryActivate(page);
  expect(activated, "reader overlay should activate").toBe(true);

  const s = await readReaderState(page);
  expect(s.present).toBe(true);
  expect(s.active).toBe(true);
  expect(s.hasShadow).toBe(true);

  // Correct article was extracted.
  expect(s.title).toContain("Skill Engineering");
  expect(s.text).toContain("Skill engineering treats capability");
  expect(s.text.length).toBeGreaterThan(800);

  // Page chrome (nav, sign-in wall, sidebars) was stripped.
  expect(s.text).not.toContain("People you may know");
  expect(s.text).not.toContain("Sign in to see more");

  // Images are preserved (read WITH images) and resolved to absolute URLs.
  expect(s.imgCount).toBeGreaterThanOrEqual(1);
  expect(s.firstImgSrc).toMatch(/^http:\/\/127\.0\.0\.1:5178\/assets\//);
});

test("toggles the reading overlay off again", async ({ page }) => {
  await page.goto(FIXTURE_URL, { waitUntil: "load" });
  expect(await tryActivate(page)).toBe(true);

  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent("force-reading-mode:toggle"))
  );
  await expect
    .poll(() => page.evaluate(() => !!document.getElementById("force-reading-mode-host")), {
      timeout: 8000,
    })
    .toBe(false);
});

test("activates via the Alt+R keyboard shortcut", async ({ page }) => {
  await page.goto(FIXTURE_URL, { waitUntil: "load" });
  // Put keyboard focus inside the page.
  await page.locator(".article-body p").first().click();
  await page.keyboard.press("Alt+R");

  await expect
    .poll(() => page.evaluate(() => !!document.getElementById("force-reading-mode-host")), {
      timeout: 8000,
    })
    .toBe(true);
});

test("neutralizes malicious markup without executing script", async ({ page }) => {
  await page.goto("http://127.0.0.1:5178/xss-article.html", { waitUntil: "load" });

  // Clear any counter the original page set for itself (e.g. its own broken
  // <img onerror>), so we measure only what the reader overlay introduces.
  await page.evaluate(() => {
    window.__frmXss = 0;
  });

  expect(await tryActivate(page)).toBe(true);
  await page.waitForTimeout(500);

  const r = await page.evaluate(() => {
    const host = document.getElementById("force-reading-mode-host");
    const sr = host && host.shadowRoot;
    const content = sr && sr.querySelector(".frm-content");
    const all = content ? Array.from(content.querySelectorAll("*")) : [];
    const anchors = content ? Array.from(content.querySelectorAll("a")) : [];
    return {
      xssFired: window.__frmXss || 0,
      jsHrefs: anchors.filter((a) =>
        (a.getAttribute("href") || "").toLowerCase().includes("javascript:")
      ).length,
      styledEls: content ? content.querySelectorAll("[style]").length : 0,
      onHandlerEls: all.filter((el) =>
        Array.prototype.some.call(el.attributes, (a) => a.name.toLowerCase().indexOf("on") === 0)
      ).length,
      svgCount: content ? content.querySelectorAll("svg").length : 0,
      jsAttrs: all.filter((el) =>
        Array.prototype.some.call(el.attributes, (a) =>
          /(?:javascript|vbscript):/i.test(a.value || "")
        )
      ).length,
      benignImg: content
        ? content.querySelectorAll('img[src$="assets/diagram.svg"]').length
        : 0,
      textLen: content ? content.innerText.trim().length : 0,
    };
  });

  // Nothing malicious survived, and no script ran when the overlay was built.
  expect(r.xssFired).toBe(0);
  expect(r.jsHrefs).toBe(0);
  expect(r.styledEls).toBe(0);
  expect(r.onHandlerEls).toBe(0);
  // No dangerous URL scheme survives in ANY attribute (covers href, xlink:href
  // inside the sanitized SVG, etc.).
  expect(r.jsAttrs).toBe(0);
  // Safe content is still rendered.
  expect(r.textLen).toBeGreaterThan(400);
  expect(r.benignImg).toBeGreaterThanOrEqual(1);
});

test("fixture server blocks sibling-directory path traversal", async () => {
  const secretDir = path.join(__dirname, "fixtures-secret");
  const secretFile = path.join(secretDir, "creds.txt");
  fs.mkdirSync(secretDir, { recursive: true });
  fs.writeFileSync(secretFile, "TOP_SECRET_TOKEN_should_not_leak");

  const rawGet = (rawPath) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: 5178, path: rawPath, method: "GET" },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on("error", reject);
      req.end();
    });

  try {
    const legit = await rawGet("/blocked-article.html");
    expect(legit.status).toBe(200);

    // Raw (un-normalized) traversal into a sibling dir whose name starts with
    // the served root — must be rejected, not leaked.
    const evil = await rawGet("/../fixtures-secret/creds.txt");
    expect(evil.status).toBe(403);
    expect(evil.body).not.toContain("TOP_SECRET_TOKEN");
  } finally {
    fs.rmSync(secretDir, { recursive: true, force: true });
  }
});

test("best-effort: extracts the real LinkedIn pulse article", async ({ page }) => {
  test.setTimeout(70000);
  try {
    await page.goto(LINKEDIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (e) {
    test.skip(true, "LinkedIn navigation failed (network/login wall): " + e.message);
  }
  await page.waitForTimeout(3500);

  const activated = await tryActivate(page, 12000);
  const s = await readReaderState(page);

  if (!activated || !s.present || s.text.length < 400) {
    test.skip(
      true,
      "LinkedIn served a login/consent wall with no readable article in this automated context."
    );
  }

  expect(s.active).toBe(true);
  expect(s.text.length).toBeGreaterThan(400);
  console.log(
    `LinkedIn extraction OK - title="${s.title}", chars=${s.text.length}, images=${s.imgCount}`
  );
});
