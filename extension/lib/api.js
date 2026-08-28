// Thin API client with bearer auth + automatic refresh-on-401.
// Tokens live in chrome.storage.local (see docs/AUTH.md for the tradeoff vs cookies).
import { getConfig } from "./config.js";

async function tokens() {
  const s = await chrome.storage.local.get("tokens");
  return s.tokens || null;
}
async function setTokens(t) { await chrome.storage.local.set({ tokens: t }); }
export async function clearTokens() { await chrome.storage.local.remove("tokens"); }
export async function isLoggedIn() { return !!(await tokens()); }

async function base() { return (await getConfig()).apiBase.replace(/\/$/, ""); }

async function raw(path, { method = "GET", body, token } = {}) {
  const res = await fetch((await base()) + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  return res;
}

// Public auth calls -------------------------------------------------
export async function signup(email, password, displayName) {
  const res = await raw("/api/auth/signup", { method: "POST", body: { email, password, display_name: displayName } });
  if (!res.ok) throw new Error((await res.json()).detail || "Signup failed");
  await setTokens(await res.json());
}
export async function login(email, password) {
  const res = await raw("/api/auth/login", { method: "POST", body: { email, password } });
  if (!res.ok) throw new Error((await res.json()).detail || "Login failed");
  await setTokens(await res.json());
}
export async function logout() {
  const t = await tokens();
  if (t) await raw("/api/auth/logout", { method: "POST", body: { refresh_token: t.refresh_token } });
  await clearTokens();
}

async function refresh() {
  const t = await tokens();
  if (!t) throw new Error("no session");
  const res = await raw("/api/auth/refresh", { method: "POST", body: { refresh_token: t.refresh_token } });
  if (!res.ok) { await clearTokens(); throw new Error("session expired"); }
  await setTokens(await res.json());
}

// Authenticated call with one automatic retry after refresh ----------
export async function apiFetch(path, opts = {}) {
  let t = await tokens();
  if (!t) throw new Error("not logged in");
  let res = await raw(path, { ...opts, token: t.access_token });
  if (res.status === 401) {
    await refresh();
    t = await tokens();
    res = await raw(path, { ...opts, token: t.access_token });
  }
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}
