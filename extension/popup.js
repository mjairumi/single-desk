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

  // A capture always lands in the local store; `synced` says whether it also
  // reached the server. Reporting a bare tick would hide an offline/CORS failure.
  const saved = (r, what) => {
    if (!r?.ok) return "Error: " + (r?.error || "unknown");
    return r.synced ? `${what} ✓ synced` : `${what} ✓ saved locally — ${r.error || "will sync later"}`;
  };

  $("saveTab").onclick = async () => {
    status("Saving…");
    const r = await send({ type: "capture-tab", url: tab.url, title: tab.title, bucket: $("bucket").value });
    status(saved(r, "Saved"));
  };
  $("saveSession").onclick = async () => {
    status("Saving session…");
    const r = await send({ type: "save-session" });
    status(saved(r, r?.session ? `Saved ${r.session.tabs.length} tabs` : "Saved"));
  };
  $("syncNow").onclick = async () => {
    status("Syncing…");
    const r = await send({ type: "sync-now" });
    status(r?.ok ? (r.changed ? `Synced ✓ ${r.changed} change${r.changed === 1 ? "" : "s"}` : "Synced ✓ up to date")
                 : "Sync error: " + (r?.error || "unknown"));
  };
  $("openApp").onclick = async () => { const cfg = await getConfig(); chrome.tabs.create({ url: cfg.apiBase }); };
}
init();
