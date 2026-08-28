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

/** Read {detail} out of an error response without assuming it is JSON. */
async function detailOf(res, fallback) {
  try {
    const body = await res.clone().json();
    if (body && body.detail) {
      return typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    }
  } catch (e) { /* not JSON — fall through */ }
  return `${fallback} (HTTP ${res.status})`;
}

async function raw(path, { method = "GET", body, token } = {}) {
  const url = (await base()) + path;
  try {
    return await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // fetch() rejects for DNS/TLS/offline *and* for a blocked CORS preflight,
    // which is by far the most common setup mistake here.
    const id = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) || "<extension-id>";
    throw new Error(
      `Can't reach ${url}. Check the API base in Options, that the server is up, ` +
      `and that CORS_ORIGINS on the server includes chrome-extension://${id}`
    );
  }
}

// Public auth calls -------------------------------------------------
export async function signup(email, password, displayName) {
  const res = await raw("/api/auth/signup", { method: "POST", body: { email, password, display_name: displayName } });
  if (!res.ok) throw new Error(await detailOf(res, "Signup failed"));
  await setTokens(await res.json());
}
export async function login(email, password) {
  const res = await raw("/api/auth/login", { method: "POST", body: { email, password } });
  if (!res.ok) throw new Error(await detailOf(res, "Login failed"));
  await setTokens(await res.json());
}
export async function logout() {
  const t = await tokens();
  if (t) {
    try { await raw("/api/auth/logout", { method: "POST", body: { refresh_token: t.refresh_token } }); }
    catch (e) { /* revoking server-side is best-effort; always drop them locally */ }
  }
  await clearTokens();
}

// Refresh tokens ROTATE: the presented one is revoked as it is exchanged. Two
// concurrent refreshes would therefore race, and the loser would invalidate a
// perfectly good session. Collapse them onto one in-flight promise.
let _refreshing = null;
function refresh() {
  if (_refreshing) return _refreshing;
  _refreshing = (async () => {
    const t = await tokens();
    if (!t) throw new Error("no session");
    const res = await raw("/api/auth/refresh", { method: "POST", body: { refresh_token: t.refresh_token } });
    if (!res.ok) { await clearTokens(); throw new Error("session expired"); }
    await setTokens(await res.json());
  })().finally(() => { _refreshing = null; });
  return _refreshing;
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
  if (!res.ok) throw new Error(await detailOf(res, `${opts.method || "GET"} ${path} failed`));
  return res.status === 204 ? null : res.json();
}
