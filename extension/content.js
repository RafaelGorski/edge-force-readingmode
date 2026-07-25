// Force Reading Mode - content script.
// Extracts the main article with Mozilla's Readability and renders it in a
// style-isolated, full-screen Shadow DOM overlay. Works on any site, including
// pages where Edge's native Immersive Reader (F9) refuses to activate.

(function () {
  "use strict";

  if (window.__forceReadingModeInstalled) return;
  window.__forceReadingModeInstalled = true;

  var HOST_ID = "force-reading-mode-host";

  // ---- Trigger wiring -------------------------------------------------------

  // From the background service worker (toolbar button + Alt+R command).
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === "FRM_TOGGLE") toggleReadingMode();
    });
  }

  // Direct Alt+R shortcut so it works even if the service worker is asleep.
  document.addEventListener(
    "keydown",
    function (e) {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        e.stopPropagation();
        toggleReadingMode();
      }
    },
    true
  );

  // DOM CustomEvent bridge: lets pages/automation trigger reading mode.
  document.addEventListener("force-reading-mode:toggle", function () {
    toggleReadingMode();
  });
  document.addEventListener("force-reading-mode:on", function () {
    activateReadingMode();
  });
  document.addEventListener("force-reading-mode:off", function () {
    deactivateReadingMode();
  });

  // ---- Toggle logic ---------------------------------------------------------

  function toggleReadingMode() {
    if (document.getElementById(HOST_ID)) {
      deactivateReadingMode();
    } else {
      activateReadingMode();
    }
  }

  function activateReadingMode() {
    if (document.getElementById(HOST_ID)) return;

    var article = extractArticle();

    var host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute("data-frm-active", "true");
    host.style.cssText =
      "all: initial; position: fixed; inset: 0; z-index: 2147483647; margin: 0; padding: 0;";

    var shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      "<style>" +
      READER_CSS +
      "</style>" +
      '<div class="frm-overlay">' +
      '  <div class="frm-toolbar">' +
      '    <span class="frm-brand">Reading mode</span>' +
      '    <div class="frm-actions">' +
      '      <button class="frm-btn frm-font-dec" title="Smaller text">A-</button>' +
      '      <button class="frm-btn frm-font-inc" title="Larger text">A+</button>' +
      '      <button class="frm-btn frm-close" title="Close (Esc)">Close \u2715</button>' +
      "    </div>" +
      "  </div>" +
      '  <main class="frm-scroll">' +
      '    <article class="frm-article">' +
      '      <h1 class="frm-title"></h1>' +
      '      <div class="frm-byline"></div>' +
      '      <div class="frm-content"></div>' +
      "    </article>" +
      "  </main>" +
      "</div>";

    shadow.querySelector(".frm-title").textContent =
      (article && article.title) || document.title || "Reading mode";

    var bylineEl = shadow.querySelector(".frm-byline");
    var bylineParts = [];
    if (article && article.byline) bylineParts.push(article.byline);
    if (article && article.siteName) bylineParts.push(article.siteName);
    else bylineParts.push(location.hostname);
    bylineEl.textContent = bylineParts.join("  \u00b7  ");

    var contentEl = shadow.querySelector(".frm-content");
    contentEl.innerHTML = sanitize((article && article.content) || "");
    resolveResourceUrls(contentEl);
    markReadableImages(contentEl);

    // Toolbar behaviour.
    var scroll = shadow.querySelector(".frm-scroll");
    var articleEl = shadow.querySelector(".frm-article");
    var fontStep = 0;
    shadow.querySelector(".frm-close").addEventListener("click", deactivateReadingMode);
    shadow.querySelector(".frm-font-inc").addEventListener("click", function () {
      fontStep = Math.min(fontStep + 1, 6);
      articleEl.style.fontSize = 100 + fontStep * 8 + "%";
    });
    shadow.querySelector(".frm-font-dec").addEventListener("click", function () {
      fontStep = Math.max(fontStep - 1, -3);
      articleEl.style.fontSize = 100 + fontStep * 8 + "%";
    });

    document.addEventListener("keydown", escHandler, true);

    // Lock the underlying page scroll while reading.
    host.dataset.prevOverflow = document.documentElement.style.overflow || "";
    document.documentElement.style.overflow = "hidden";

    (document.documentElement || document.body).appendChild(host);
    if (scroll) scroll.scrollTop = 0;
  }

  function deactivateReadingMode() {
    var host = document.getElementById(HOST_ID);
    if (!host) return;
    document.documentElement.style.overflow = host.dataset.prevOverflow || "";
    document.removeEventListener("keydown", escHandler, true);
    host.remove();
  }

  function escHandler(e) {
    if (e.key === "Escape" && document.getElementById(HOST_ID)) {
      e.preventDefault();
      e.stopPropagation();
      deactivateReadingMode();
    }
  }

  // ---- Extraction -----------------------------------------------------------

  function extractArticle() {
    try {
      if (typeof Readability === "function") {
        var docClone = document.cloneNode(true);
        var parsed = new Readability(docClone, { charThreshold: 200 }).parse();
        if (
          parsed &&
          parsed.content &&
          parsed.textContent &&
          parsed.textContent.trim().length > 100
        ) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn("Force Reading Mode: Readability failed, using fallback.", err);
    }
    return fallbackExtract();
  }

  // Heuristic fallback: choose the visible container with the most text.
  function fallbackExtract() {
    var best = null;
    var bestLen = 0;
    var selectors =
      "article, main, [role='main'], .article, .article-content, .post, .post-content, .content, .entry-content";
    var candidates = document.querySelectorAll(selectors);
    for (var i = 0; i < candidates.length; i++) {
      var text = candidates[i].innerText || "";
      if (text.length > bestLen) {
        bestLen = text.length;
        best = candidates[i];
      }
    }
    if (!best || bestLen < 200) best = document.body;
    return {
      title: document.title || "Reading mode",
      byline: "",
      siteName: location.hostname,
      content: "<div>" + (best ? best.innerHTML : "") + "</div>",
      textContent: best ? best.innerText || "" : "",
    };
  }

  // ---- Helpers --------------------------------------------------------------

  // Allowlist sanitizer. Prefer DOMPurify (vetted; correctly handles namespaced
  // attributes like xlink:href, dangerous URI schemes, inline styles and
  // mutation-XSS). Falls back to a hardened, fail-closed denylist only if
  // DOMPurify somehow isn't loaded. URL scheme safety for any surviving
  // src/href is enforced centrally in resolveResourceUrls().
  function sanitize(html) {
    if (typeof DOMPurify !== "undefined" && DOMPurify && DOMPurify.sanitize) {
      return DOMPurify.sanitize(html, {
        FORBID_TAGS: ["style", "base", "form", "input", "button", "textarea", "select"],
        FORBID_ATTR: ["style"],
        ALLOW_DATA_ATTR: false,
      });
    }
    return fallbackSanitize(html);
  }

  function fallbackSanitize(html) {
    var tpl = document.createElement("template");
    tpl.innerHTML = html;
    var strip = tpl.content.querySelectorAll(
      "script, style, link, meta, base, noscript, iframe, object, embed, form, input, button, svg, math"
    );
    for (var i = 0; i < strip.length; i++) strip[i].remove();

    var all = tpl.content.querySelectorAll("*");
    for (var j = 0; j < all.length; j++) {
      var el = all[j];
      var attrs = Array.prototype.slice.call(el.attributes);
      for (var k = 0; k < attrs.length; k++) {
        var name = attrs[k].name.toLowerCase();
        // Drop event handlers, inline styles, srcset, and every namespaced
        // attribute (e.g. xlink:href). Plain href/src are left for
        // resolveResourceUrls(), which enforces a strict scheme allowlist.
        if (
          name.indexOf("on") === 0 ||
          name === "style" ||
          name === "srcset" ||
          name === "formaction" ||
          name === "action" ||
          name.indexOf(":") !== -1
        ) {
          el.removeAttribute(attrs[k].name);
        }
      }
    }
    return tpl.innerHTML;
  }

  // Only http(s) are allowed for images; http(s)/mailto/tel for links. Data
  // URIs are permitted for images only. Everything else (javascript:, vbscript:,
  // arbitrary data:, etc.) is rejected AFTER URL normalization, so obfuscated
  // schemes such as "jav\tascript:" cannot be reconstructed into live handlers.
  function safeUrl(value, base, isImage) {
    if (!value) return null;
    try {
      var u = new URL(value, base);
      if (u.protocol === "http:" || u.protocol === "https:") return u.href;
      if (isImage && u.protocol === "data:" && /^data:image\//i.test(u.href)) return u.href;
      if (!isImage && (u.protocol === "mailto:" || u.protocol === "tel:")) return u.href;
    } catch (e) {}
    return null;
  }

  // Make relative image/link URLs absolute and enforce the scheme allowlist.
  function resolveResourceUrls(root) {
    var base = document.baseURI;
    var imgs = root.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var src = img.getAttribute("src");
      var dataSrc = img.getAttribute("data-src") || img.getAttribute("data-delayed-url");
      if ((!src || src.indexOf("data:") === 0) && dataSrc) src = dataSrc;
      img.removeAttribute("srcset");
      var safeSrc = safeUrl(src, base, true);
      if (safeSrc) {
        img.setAttribute("src", safeSrc);
        img.setAttribute("loading", "eager");
        img.setAttribute("referrerpolicy", "no-referrer");
      } else {
        img.remove();
      }
    }
    var links = root.querySelectorAll("a[href]");
    for (var j = 0; j < links.length; j++) {
      var safeHref = safeUrl(links[j].getAttribute("href"), base, false);
      if (safeHref) {
        links[j].setAttribute("href", safeHref);
        links[j].setAttribute("target", "_blank");
        links[j].setAttribute("rel", "noopener noreferrer");
      } else {
        links[j].removeAttribute("href");
      }
    }
  }

  function markReadableImages(root) {
    var imgs = root.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) imgs[i].classList.add("frm-img");
  }

  // ---- Styles ---------------------------------------------------------------

  var READER_CSS =
    ":host { all: initial; }" +
    ".frm-overlay { position: absolute; inset: 0; display: flex; flex-direction: column;" +
    "  background: #faf8f3; color: #1a1a1a; font-family: Georgia, 'Times New Roman', serif; }" +
    ".frm-toolbar { position: sticky; top: 0; display: flex; align-items: center;" +
    "  justify-content: space-between; gap: 12px; padding: 10px 18px; background: #f0ece3;" +
    "  border-bottom: 1px solid #d9d2c5; font-family: -apple-system, Segoe UI, Roboto, sans-serif;" +
    "  box-shadow: 0 1px 4px rgba(0,0,0,0.06); }" +
    ".frm-brand { font-weight: 600; font-size: 14px; color: #5a5245; letter-spacing: .02em; }" +
    ".frm-actions { display: flex; gap: 8px; }" +
    ".frm-btn { font: inherit; font-size: 13px; padding: 6px 12px; border: 1px solid #cdc5b6;" +
    "  border-radius: 6px; background: #fff; color: #333; cursor: pointer; line-height: 1; }" +
    ".frm-btn:hover { background: #f6f2ea; border-color: #b7ad9a; }" +
    ".frm-close { font-weight: 600; }" +
    ".frm-scroll { flex: 1 1 auto; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; }" +
    ".frm-article { max-width: 720px; margin: 0 auto; padding: 48px 24px 120px;" +
    "  font-size: 100%; line-height: 1.7; }" +
    ".frm-title { font-size: 2.1em; line-height: 1.25; margin: 0 0 12px; color: #14110c; }" +
    ".frm-byline { font-family: -apple-system, Segoe UI, Roboto, sans-serif; font-size: .82em;" +
    "  color: #7a7264; margin-bottom: 32px; padding-bottom: 16px; border-bottom: 1px solid #e4ddcf; }" +
    ".frm-content { font-size: 1.15em; }" +
    ".frm-content p { margin: 0 0 1.25em; }" +
    ".frm-content h1, .frm-content h2, .frm-content h3, .frm-content h4 {" +
    "  line-height: 1.3; margin: 1.6em 0 .6em; color: #14110c; }" +
    ".frm-content a { color: #0b5cad; text-decoration: underline; }" +
    ".frm-content img, .frm-content .frm-img { display: block; max-width: 100%; height: auto;" +
    "  margin: 1.5em auto; border-radius: 6px; }" +
    ".frm-content figure { margin: 1.5em 0; }" +
    ".frm-content figcaption { font-size: .82em; color: #7a7264; text-align: center; margin-top: .5em; }" +
    ".frm-content blockquote { margin: 1.5em 0; padding: .2em 1.2em; border-left: 4px solid #d9c9a3;" +
    "  color: #4a4436; font-style: italic; }" +
    ".frm-content pre { overflow: auto; background: #f0ece3; padding: 1em; border-radius: 6px; font-size: .9em; }" +
    ".frm-content code { font-family: 'SFMono-Regular', Consolas, monospace; font-size: .9em; }" +
    ".frm-content ul, .frm-content ol { margin: 0 0 1.25em; padding-left: 1.4em; }" +
    ".frm-content li { margin: .4em 0; }" +
    ".frm-content hr { border: none; border-top: 1px solid #e0d9ca; margin: 2em 0; }" +
    "@media (max-width: 600px) { .frm-article { padding: 28px 18px 100px; } .frm-title { font-size: 1.7em; } }";
})();
