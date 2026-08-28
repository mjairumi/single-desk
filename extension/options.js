import { getConfig, setConfig } from "./lib/config.js";
import { login, signup, logout, isLoggedIn, apiFetch } from "./lib/api.js";

const $ = (id) => document.getElementById(id);
function status(t, ok = true) { const s = $("status"); s.textContent = t; s.style.color = ok ? "#0f6e66" : "#af4632"; }
let mode = "login";

async function refreshAuthUI() {
  const logged = await isLoggedIn();
  $("loggedOutBox").style.display = logged ? "none" : "block";
  $("loggedInBox").style.display = logged ? "block" : "none";
  if (logged) {
    try { const me = await apiFetch("/api/auth/me"); $("whoami").textContent = me.email; }
    catch { $("whoami").textContent = "(session expired — log in again)"; }
  }
}

async function init() {
  $("extId").textContent = chrome.runtime.id;
  const cfg = await getConfig();
  $("apiBase").value = cfg.apiBase;

  $("saveServer").onclick = async () => { await setConfig({ apiBase: $("apiBase").value.trim() }); status("Server settings saved ✓"); };

  $("tabLogin").onclick = () => setMode("login");
  $("tabSignup").onclick = () => setMode("signup");

  $("doAuth").onclick = async () => {
    try {
      status("…");
      const email = $("email").value.trim(), pw = $("password").value;
      if (mode === "signup") await signup(email, pw, $("displayName").value.trim());
      else await login(email, pw);
      status("Signed in ✓");
      await refreshAuthUI();
      chrome.runtime.sendMessage({ type: "sync-now" });
    } catch (e) { status(e.message, false); }
  };
  $("logout").onclick = async () => { await logout(); status("Logged out"); refreshAuthUI(); };
  $("syncNow").onclick = async () => { status("Syncing…"); const r = await chrome.runtime.sendMessage({ type: "sync-now" }); status(r?.ok ? "Synced ✓" : "Sync error", !!r?.ok); };
  $("rebuild").onclick = async () => { status("Rebuilding mirror…"); const r = await chrome.runtime.sendMessage({ type: "rebuild-mirror" }); status(r?.ok ? "Mirror rebuilt ✓" : "Error", !!r?.ok); };

  await refreshAuthUI();
}

function setMode(m) {
  mode = m;
  $("tabLogin").classList.toggle("on", m === "login");
  $("tabSignup").classList.toggle("on", m === "signup");
  $("doAuth").textContent = m === "signup" ? "Create account" : "Log in";
  $("nameLabel").style.display = m === "signup" ? "block" : "none";
  $("displayName").style.display = m === "signup" ? "block" : "none";
}
init();
