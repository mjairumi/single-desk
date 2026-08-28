import { isLoggedIn } from "./lib/api.js";
import { getConfig } from "./lib/config.js";

const $ = (id) => document.getElementById(id);
function send(msg) { return chrome.runtime.sendMessage(msg); }
function status(t) { $("status").textContent = t || ""; }

async function init() {
  const logged = await isLoggedIn();
  $("loggedIn").classList.toggle("hidden", !logged);
  $("loggedOut").classList.toggle("hidden", logged);
  if (!logged) {
    $("openOptions").onclick = () => chrome.runtime.openOptionsPage();
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("tabTitle").textContent = tab?.title || tab?.url || "—";

  $("saveTab").onclick = async () => {
    status("Saving…");
    const r = await send({ type: "capture-tab", url: tab.url, title: tab.title, bucket: $("bucket").value });
    status(r?.ok ? "Saved ✓" : "Error: " + (r?.error || "unknown"));
  };
  $("saveSession").onclick = async () => {
    status("Saving session…");
    const r = await send({ type: "save-session" });
    status(r?.ok ? `Saved ${r.session.tabs.length} tabs ✓` : "Error: " + (r?.error || ""));
  };
  $("syncNow").onclick = async () => { status("Syncing…"); const r = await send({ type: "sync-now" }); status(r?.ok ? "Synced ✓" : "Sync error"); };
  $("openApp").onclick = async () => { const cfg = await getConfig(); chrome.tabs.create({ url: cfg.apiBase }); };
}
init();
