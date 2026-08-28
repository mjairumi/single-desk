// Service worker: wires alarms, bookmark events, and popup/options messages to
// the sync engine + bookmark engine.
import { getConfig } from "./lib/config.js";
import { syncNow, upsertItem } from "./lib/sync.js";
import * as bm from "./lib/bookmarks.js";
import { captureCurrentWindow, restoreSession } from "./lib/sessions.js";
import { isLoggedIn } from "./lib/api.js";

async function scheduleSync() {
  const cfg = await getConfig();
  chrome.alarms.create("sync", { periodInMinutes: Math.max(1, cfg.syncIntervalMin) });
}

// Pull/push, then mirror any changed items into Chrome bookmarks.
async function runSync() {
  const changed = await syncNow();
  if (changed.changedItems.length) await bm.applyItemsToChrome(changed.changedItems);
  return changed;
}

async function bootstrap() {
  await bm.ensureManagedTree();
  await scheduleSync();
  if (await isLoggedIn()) { await runSync(); await bm.reconcileAll(); }
}

chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup.addListener(bootstrap);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "sync") runSync(); });

// Debounce pushes triggered by a burst of bookmark edits (e.g. an import).
let pushTimer = null;
function debouncedSync() { clearTimeout(pushTimer); pushTimer = setTimeout(runSync, 1500); }

chrome.bookmarks.onCreated.addListener(async (id, node) => { if (await bm.onBookmarkCreated(id, node)) debouncedSync(); });
chrome.bookmarks.onChanged.addListener(async (id, ci) => { if (await bm.onBookmarkChanged(id, ci)) debouncedSync(); });
chrome.bookmarks.onMoved.addListener(async (id, mi) => { if (await bm.onBookmarkMoved(id, mi)) debouncedSync(); });
chrome.bookmarks.onRemoved.addListener(async (id, ri) => { if (await bm.onBookmarkRemoved(id, ri)) debouncedSync(); });

// Messages from popup / options.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "capture-tab": {
          const item = await upsertItem({ url: msg.url, title: msg.title, bucket: msg.bucket || "inbox", note: msg.note || "" });
          await runSync();
          return sendResponse({ ok: true, item });
        }
        case "save-session": {
          const session = await captureCurrentWindow(msg.name);
          await runSync();
          return sendResponse({ ok: true, session });
        }
        case "restore-session":
          await restoreSession(msg.session);
          return sendResponse({ ok: true });
        case "sync-now":
          await runSync(); await bm.reconcileAll();
          return sendResponse({ ok: true });
        case "rebuild-mirror":
          // Wipe local bookmark map + regenerate the managed tree from items.
          await bm.reconcileAll();
          return sendResponse({ ok: true });
        default:
          return sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) { sendResponse({ ok: false, error: e.message }); }
  })();
  return true; // keep the message channel open for the async response
});
