// "Groups" = saved tab sessions. Capture the current window's tabs (preserving
// Chrome tab-group title/color where present) and restore them later.
import { upsertSession } from "./sync.js";

function defaultName() {
  const d = new Date();
  return `Session ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export async function captureCurrentWindow(name) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const groupCache = {};
  const out = [];
  for (const t of tabs) {
    if (!t.url || t.url.startsWith("chrome://") || t.url.startsWith("chrome-extension://")) continue;
    let groupTitle = null, groupColor = null;
    if (t.groupId != null && t.groupId >= 0) {
      if (!(t.groupId in groupCache)) {
        try { groupCache[t.groupId] = await chrome.tabGroups.get(t.groupId); }
        catch { groupCache[t.groupId] = null; }
      }
      const g = groupCache[t.groupId];
      if (g) { groupTitle = g.title || null; groupColor = g.color || null; }
    }
    out.push({ url: t.url, title: t.title || t.url, groupTitle, groupColor });
  }
  return upsertSession({ name: name || defaultName(), tabs: out });
}

export async function restoreSession(session) {
  const urls = session.tabs.map((t) => t.url);
  if (!urls.length) return;
  const win = await chrome.windows.create({ url: urls });
  // Best-effort: re-create tab groups by grouping consecutive tabs that share a
  // groupTitle. chrome.windows.create returns tabs in the same order as `urls`.
  try {
    const created = win.tabs || (await chrome.tabs.query({ windowId: win.id }));
    let i = 0;
    while (i < session.tabs.length) {
      const gt = session.tabs[i].groupTitle;
      if (!gt) { i++; continue; }
      const idsInGroup = [];
      let j = i;
      while (j < session.tabs.length && session.tabs[j].groupTitle === gt) {
        if (created[j]) idsInGroup.push(created[j].id);
        j++;
      }
      if (idsInGroup.length) {
        const groupId = await chrome.tabs.group({ tabIds: idsInGroup });
        await chrome.tabGroups.update(groupId, { title: gt, color: session.tabs[i].groupColor || "grey" });
      }
      i = j;
    }
  } catch (e) {
    console.warn("[signal-desk] could not restore tab groups:", e.message);
  }
}
