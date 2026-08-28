// Service worker: wires alarms, bookmark events, and popup/options messages to
// the sync engine + bookmark engine.
import { getConfig } from "./lib/config.js";
import { syncNow, upsertItem } from "./lib/sync.js";
import * as bm from "./lib/bookmarks.js";
import { captureCurrentWindow, restoreSession } from "./lib/sessions.js";
import { isLoggedIn } from "./lib/api.js";

async function mirroringOn() { return (await getConfig()).mirrorBookmarks === true; }

async function scheduleSync() {
  const cfg = await getConfig();
  chrome.alarms.create("sync", { periodInMinutes: Math.max(1, cfg.syncIntervalMin) });
}

// Pull/push, then (only once bookmark mirroring is enabled) reflect the changed
// items into Chrome bookmarks. Returns the sync result so callers can report it.
async function runSync() {
  const result = await syncNow();
  if (result.ok && result.changedItems.length && (await mirroringOn())) {
    try { await bm.applyItemsToChrome(result.changedItems); }
    catch (e) { console.warn("[signal-desk] bookmark mirror failed:", e.message); }
  }
  return result;
}

async function bootstrap() {
  await scheduleSync();
  if (await mirroringOn()) await bm.ensureManagedTree();
  if (await isLoggedIn()) {
    await runSync();
    if (await mirroringOn()) await bm.reconcileAll();
  }
}

chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup.addListener(bootstrap);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "sync") runSync(); });

// Debounce pushes triggered by a burst of bookmark edits (e.g. an import).
let pushTimer = null;
function debouncedSync() { clearTimeout(pushTimer); pushTimer = setTimeout(runSync, 1500); }

// Bookmark listeners stay registered but no-op while mirroring is off, so a
// half-built mirror can't invent or tombstone items behind the user's back.
chrome.bookmarks.onCreated.addListener(async (id, node) => {
  if (await mirroringOn() && await bm.onBookmarkCreated(id, node)) debouncedSync();
});
chrome.bookmarks.onChanged.addListener(async (id, ci) => {
  if (await mirroringOn() && await bm.onBookmarkChanged(id, ci)) debouncedSync();
});
chrome.bookmarks.onMoved.addListener(async (id, mi) => {
  if (await mirroringOn() && await bm.onBookmarkMoved(id, mi)) debouncedSync();
});
chrome.bookmarks.onRemoved.addListener(async (id, ri) => {
  if (await mirroringOn() && await bm.onBookmarkRemoved(id, ri)) debouncedSync();
});

// Messages from popup / options.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case "capture-tab": {
          const item = await upsertItem({ url: msg.url, title: msg.title, bucket: msg.bucket || "inbox", note: msg.note || "" });
          const r = await runSync();
          // The item is saved locally either way; report whether it reached the
          // server so the popup can't claim success while offline.
          return sendResponse({ ok: true, item, synced: r.ok, error: r.error });
        }
        case "save-session": {
          const session = await captureCurrentWindow(msg.name);
          const r = await runSync();
          return sendResponse({ ok: true, session, synced: r.ok, error: r.error });
        }
        case "restore-session":
          await restoreSession(msg.session);
          return sendResponse({ ok: true });
        case "sync-now": {
          const r = await runSync();
          if (r.ok && await mirroringOn()) await bm.reconcileAll();
          return sendResponse({ ok: r.ok, error: r.error, changed: r.changedItems.length + r.changedSessions.length });
        }
        case "rebuild-mirror": {
          if (!(await mirroringOn())) {
            return sendResponse({ ok: false, error: "Bookmark mirroring is off (see Options)." });
          }
          await bm.ensureManagedTree();
          await bm.reconcileAll();
          return sendResponse({ ok: true });
        }
        default:
          return sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) { sendResponse({ ok: false, error: e.message }); }
  })();
  return true; // keep the message channel open for the async response
});
