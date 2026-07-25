// Background service worker: routes the toolbar button and the Alt+R command
// to the active tab's content script. Falls back to programmatic injection when
// the content script isn't present yet (e.g. right after install).

async function triggerReadingMode(tab) {
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "FRM_TOGGLE" });
  } catch (err) {
    // Content script may not be loaded on this page yet; inject and retry.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["purify.js", "Readability.js", "content.js"],
      });
      await chrome.tabs.sendMessage(tab.id, { type: "FRM_TOGGLE" });
    } catch (err2) {
      console.warn("Force Reading Mode: cannot run on this page.", err2);
    }
  }
}

chrome.action.onClicked.addListener((tab) => {
  triggerReadingMode(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "toggle-reading-mode") {
    triggerReadingMode(tab);
  }
});
