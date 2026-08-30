// Signal Desk — web app.
//
// Ported from the standalone localStorage build (web/legacy-localstorage-ui.html)
// onto the sync API. Every bucket / review / playbook feature is preserved; the
// data layer is now Store + syncNow from ./api-client.js, behind a login gate,
// with a Groups (tab sessions) view added.
//
// ENTITY SHAPE: rows are held in EXACTLY the API's shape — snake_case fields,
// ISO-8601 timestamps — so sync payloads are 1:1 with the server (see
// docs/API.md). The legacy UI used camelCase + epoch-ms and did arithmetic on
// the numbers directly; `ms()` parses at the point of use instead, so there is
// only ever one spelling of a field in this file.
import {
  Auth, isLoggedIn, Store, upsertItem, deleteItem, upsertSession,
  syncNow, liveItems, liveSessions, loadPreviews, fetchPreviews,
} from "./api-client.js";

const DAY = 86400000;

const VIEWS = [
  { id: "overview", label: "Overview" },
  { id: "inbox", label: "Inbox" },
  { id: "library", label: "Library" },
  { id: "rounds", label: "Rounds" },
  { id: "queue", label: "Read-later" },
  { id: "explore", label: "Explore" },
  { id: "groups", label: "Groups" },
  { id: "archive", label: "Archive" },
  { id: "playbook", label: "Playbook" },
];
const BUCKET_LABEL = {
  inbox: "Inbox", library: "Library", rounds: "Rounds",
  queue: "Read-later", explore: "Explore", archive: "Archive",
};

// ---------- device-local preferences (theme, default shelf life) ----------
// Not synced: these are per-device display choices, not entities in the model.
const PREFS_KEY = "signaldesk.prefs";
let prefs = { shelfDays: 30, theme: "system" };
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) prefs = { ...prefs, ...JSON.parse(raw) };
  } catch (e) { /* private mode — defaults are fine */ }
}
function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) {}
}

// ---------- state ----------
let items = [];      // live (non-tombstoned) items, API shape
let sessions = [];   // live tab sessions, API shape
let current = "overview";
let libFilterTag = null, libSearch = "";
let explFilterTag = null, explSearch = "";
let main = null;

// ---------- helpers ----------
const now = () => Date.now();
/** Parse an ISO-8601 timestamp to epoch-ms. Returns null for null/invalid. */
function ms(v) {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
/** epoch-ms (or now) as ISO-8601 — the shape the API stores. */
const iso = (m) => new Date(m == null ? Date.now() : m).toISOString();

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function host(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return u; } }
function niceTitle(it) { return it.title && it.title.trim() ? it.title.trim() : (it.url ? host(it.url) : "Untitled"); }
function initial(it) { const t = niceTitle(it).replace(/^https?:\/\//, ""); return (t[0] || "?").toUpperCase(); }
function normUrl(u) {
  u = (u || "").trim();
  if (!u) return "";
  if (!/^[a-z]+:\/\//i.test(u) && !/^[a-z]+:/i.test(u)) u = "https://" + u;
  return u;
}
function tagList(s) { return (s || "").split(",").map((t) => t.trim()).filter(Boolean); }
function fmtRel(m) {
  if (m == null) return "—";
  const d = Math.round((m - now()) / DAY);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  return d > 0 ? "in " + d + "d" : Math.abs(d) + "d ago";
}
function ageDays(m) { return m == null ? 0 : Math.floor((now() - m) / DAY); }
function bind(sel, ev, fn) { const el = document.querySelector(sel); if (el) el.addEventListener(ev, fn); }
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove("show"), 2400);
}

// ---------- derived ----------
function snoozed(it) { const s = ms(it.snoozed_until); return s != null && s > now(); }
function roundDue(it) {
  const base = ms(it.last_visited) ?? ms(it.added_at) ?? now();
  return base + ((it.cadence_days || 7) * DAY);
}
function isRoundDue(it) { return now() >= roundDue(it); }
function isRoundOverdue(it) { return now() > roundDue(it) + ((it.cadence_days || 7) * DAY); }
function queueExpires(it) { return (ms(it.added_at) ?? now()) + ((it.shelf_days || prefs.shelfDays) * DAY); }
function queueOverdue(it) { return now() > queueExpires(it); }
function queueSoon(it) { return !queueOverdue(it) && now() > queueExpires(it) - 5 * DAY; }
function archiveOld(it) { return now() > (ms(it.archived_at) ?? ms(it.added_at) ?? now()) + 90 * DAY; }

function byBucket(b) { return items.filter((it) => it.bucket === b); }
function attn() {
  return {
    inbox: byBucket("inbox").filter((it) => !snoozed(it)),
    due: byBucket("rounds").filter((it) => isRoundDue(it) && !snoozed(it)),
    over: byBucket("queue").filter((it) => queueOverdue(it) && !snoozed(it)),
    purge: byBucket("archive").filter(archiveOld),
  };
}
function reviewQueue() {
  const a = attn(), seen = {}, out = [];
  const push = (list, reason) => list.forEach((it) => {
    if (!seen[it.id]) { seen[it.id] = 1; out.push({ it, reason }); }
  });
  push(a.inbox, "Unsorted — decide where this belongs.");
  push(a.over, "Read-later, past its shelf life. Read it now or let it go.");
  push(a.due, "Due for a revisit on your rounds.");
  return out;
}
function find(id) { return items.find((it) => it.id === id) || null; }

// ============================================================================
// Data layer — every mutation goes through api-client, which stamps updated_at
// and marks the row _dirty for the next push.
// ============================================================================
async function reloadFromCache() {
  items = await liveItems();
  sessions = await liveSessions();
  // Newest first by default; per-view sorts refine this.
  items.sort((a, b) => (ms(b.added_at) ?? 0) - (ms(a.added_at) ?? 0));
}

async function addItem(o) {
  const patch = {
    url: o.url || null,
    title: o.title || "",
    note: o.note || "",
    tags: o.tags || [],
    bucket: o.bucket || "inbox",
    added_at: o.added_at || iso(),
  };
  if (patch.bucket === "rounds") { patch.cadence_days = o.cadence_days || 7; patch.last_visited = iso(); }
  if (patch.bucket === "queue") { patch.shelf_days = o.shelf_days || prefs.shelfDays; }
  if (patch.bucket === "archive") { patch.archived_at = iso(); }
  const row = await upsertItem(patch);
  await afterMutation();
  return row;
}

async function moveTo(it, bucket, opts = {}) {
  const patch = { id: it.id, bucket, snoozed_until: null };
  if (bucket === "rounds") {
    patch.cadence_days = opts.cadence_days || it.cadence_days || 7;
    patch.last_visited = iso();
  }
  if (bucket === "queue") {
    patch.shelf_days = opts.shelf_days || it.shelf_days || prefs.shelfDays;
    patch.added_at = iso();          // the shelf clock restarts on entry
  }
  if (bucket === "archive") patch.archived_at = iso();
  await upsertItem(patch);
  await afterMutation();
}

async function snoozeItem(it) {
  const patch = { id: it.id, snoozed_until: iso(now() + 14 * DAY) };
  if (it.bucket === "rounds") patch.last_visited = iso();
  if (it.bucket === "queue") patch.added_at = iso();
  await upsertItem(patch);
  await afterMutation();
}

// Tombstone, never a hard delete — deletions have to propagate to other devices.
async function removeItem(id) {
  await deleteItem(id);
  await afterMutation();
}

async function afterMutation() {
  await reloadFromCache();
  render();
  scheduleSync();
}

// ============================================================================
// Sync
// ============================================================================
let syncTimer = null, syncing = false;
function setSyncStatus(text, kind) {
  const el = document.getElementById("syncInfo");
  if (!el) return;
  el.textContent = text;
  el.className = "mono sync-" + (kind || "idle");
}

async function doSync({ quiet = true } = {}) {
  if (syncing) return;
  if (!isLoggedIn()) { showAuth(); return; }
  syncing = true;
  if (!quiet) setSyncStatus("Syncing…", "busy");
  try {
    await syncNow();
    await reloadFromCache();
    render();
    setSyncStatus(items.length + " links · synced", "ok");
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/session expired|not logged in/i.test(msg)) {
      showAuth();
      return;
    }
    // Offline or the server is down: the cache is authoritative until we're back.
    setSyncStatus("offline — changes saved locally", "warn");
  } finally {
    syncing = false;
  }
}

// Debounce the push that follows a burst of edits.
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => doSync(), 1200);
}

// ============================================================================
// Auth gate
// ============================================================================
let authMode = "login";
function showAuth() {
  document.getElementById("authGate").style.display = "flex";
  document.getElementById("appShell").style.display = "none";
  setAuthMode(authMode);
}
function showApp() {
  document.getElementById("authGate").style.display = "none";
  document.getElementById("appShell").style.display = "block";
}
function setAuthMode(m) {
  authMode = m;
  document.getElementById("authTabLogin").classList.toggle("on", m === "login");
  document.getElementById("authTabSignup").classList.toggle("on", m === "signup");
  document.getElementById("authSubmit").textContent = m === "signup" ? "Create account" : "Log in";
  document.getElementById("authNameRow").style.display = m === "signup" ? "block" : "none";
  document.getElementById("authHint").textContent = m === "signup"
    ? "Your links sync across every device you sign in on."
    : "Welcome back.";
}
function authError(msg) {
  const el = document.getElementById("authError");
  el.textContent = msg || "";
  el.style.display = msg ? "block" : "none";
}
async function submitAuth() {
  const email = document.getElementById("authEmail").value.trim();
  const pw = document.getElementById("authPassword").value;
  if (!email || !pw) { authError("Email and password are both required."); return; }
  if (authMode === "signup" && pw.length < 8) { authError("Password must be at least 8 characters."); return; }
  const btn = document.getElementById("authSubmit");
  btn.disabled = true; authError(""); btn.textContent = "…";
  try {
    if (authMode === "signup") {
      await Auth.signup(email, pw, document.getElementById("authName").value.trim() || null);
    } else {
      await Auth.login(email, pw);
    }
    showApp();
    await reloadFromCache();
    render();
    await doSync({ quiet: false });
  } catch (e) {
    authError(String(e && e.message || e));
  } finally {
    btn.disabled = false;
    setAuthMode(authMode);
  }
}
async function doLogout() {
  try { await Auth.logout(); } catch (e) { /* revoking is best-effort */ }
  items = []; sessions = [];
  showAuth();
  toast("Logged out.");
}

// ============================================================================
// Rendering
// ============================================================================
function renderNav() {
  const a = attn();
  const counts = { inbox: a.inbox.length, rounds: a.due.length, queue: a.over.length };
  const alertKind = { rounds: "warn", queue: "alert", inbox: "warn" };
  document.getElementById("nav").innerHTML = VIEWS.map((v) => {
    let badge = "";
    const c = counts[v.id];
    if (c != null && c > 0) badge = '<span class="count ' + (alertKind[v.id] || "") + '">' + c + "</span>";
    if (v.id === "library") { const n = byBucket("library").length; badge = n > 0 ? '<span class="count">' + n + "</span>" : ""; }
    if (v.id === "explore") { const n = byBucket("explore").length; badge = n > 0 ? '<span class="count">' + n + "</span>" : ""; }
    if (v.id === "archive") { const n = byBucket("archive").length; badge = n > 0 ? '<span class="count">' + n + "</span>" : ""; }
    if (v.id === "groups") { const n = sessions.length; badge = n > 0 ? '<span class="count">' + n + "</span>" : ""; }
    return '<button class="navbtn' + (current === v.id ? " active" : "") + '" data-view="' + v.id + '">' + v.label + badge + "</button>";
  }).join("");
}

// ============================================================================
// Peek — one window, reused
//
// A preview tells you what a link is; sometimes you still need to LOOK before
// you can file it. Framing the page is not an option: most of the web sends
// X-Frame-Options or frame-ancestors (8 of 11 sites sampled while building
// this, including GitHub, MDN and Hacker News), a blocked iframe still fires
// `load`, and same-origin policy hides what's inside — so a client that tries
// paints a blank rectangle it cannot even detect. A popup window is subject to
// none of that: no framing header can refuse it.
//
// The reuse trick is the second argument. Passing a NAME makes the browser
// steer the window that already carries that name instead of opening another,
// so triaging thirty links costs one window rather than thirty tabs. The name
// outlives this page, so a reload keeps reusing the same window.
// ============================================================================
const PEEK_TARGET = "signal-desk-peek";

function peek(url) {
  if (!url) return;
  // Size applies to the first open only; later calls just navigate the window
  // that answers to PEEK_TARGET, which is exactly the point.
  const win = window.open(url, PEEK_TARGET, "width=1040,height=820");
  if (!win) { toast("Your browser blocked the peek window — allow popups for this site."); return; }
  win.focus();
}

// ============================================================================
// Link previews
//
// Triage is a glance-and-decide loop, so a card has to say what a link IS
// before you can file it. The server fetches and caches the metadata
// (app/preview.py); this side decides WHEN to ask and paints the answer in.
//
// Asking is lazy and viewport-driven: an IntersectionObserver queues the URL of
// each card as it nears the screen, and the queue is flushed in debounced
// batches. So a 400-item Library costs one request for the dozen rows you can
// actually see, and nothing at all for the rest.
//
// Results are painted into the existing DOM rather than triggering a re-render:
// a full render() would reset scroll position underneath someone mid-triage.
// ============================================================================
const previews = new Map();          // url (as the item holds it) -> preview row
const previewPending = new Set();     // in flight — don't ask twice
const previewQueue = new Set();       // seen on screen, not yet asked
let previewTimer = null;
let previewObserver = null;
const PREVIEW_BATCH = 24;             // matches the server's per-request cap

function previewOf(it) { return it && it.url ? previews.get(it.url) || null : null; }

// A preview is only worth showing if it says something the card doesn't already.
function usefulPreview(p) { return !!(p && p.status === "ok" && (p.description || p.image_url)); }

function queuePreview(url) {
  if (!url || previews.has(url) || previewPending.has(url)) return;
  previewQueue.add(url);
  clearTimeout(previewTimer);
  previewTimer = setTimeout(flushPreviews, 120);
}

async function flushPreviews() {
  const batch = [...previewQueue].slice(0, PREVIEW_BATCH);
  if (!batch.length) return;
  batch.forEach((u) => { previewQueue.delete(u); previewPending.add(u); });
  try {
    for (const row of await fetchPreviews(batch)) {
      previews.set(row.key, row);
      paintPreview(row);
    }
  } catch (e) {
    // Offline, or the session expired mid-scroll. Previews are decoration:
    // drop the batch and let the next render ask again.
  } finally {
    batch.forEach((u) => previewPending.delete(u));
    if (previewQueue.size) { clearTimeout(previewTimer); previewTimer = setTimeout(flushPreviews, 120); }
  }
}

// `referrerpolicy` keeps the sites you saved from learning which app is
// rendering them; `loading=lazy` keeps a long list from opening 200 sockets.
function favImg(p) {
  return '<img src="' + esc(p.icon_url) + '" alt="" loading="lazy" referrerpolicy="no-referrer">';
}

function previewInner(p, thumbClass) {
  if (!usefulPreview(p)) return "";
  return (p.image_url ? '<img class="' + thumbClass + '" src="' + esc(p.image_url) +
      '" alt="" loading="lazy" referrerpolicy="no-referrer">' : "") +
    (p.description ? '<div class="pv-desc">' + esc(p.description) + "</div>" : "");
}

// Fill one already-rendered card from a preview row.
function applyPreview(el, p, thumbClass) {
  const fav = el.querySelector(".fav");
  if (fav && p.status === "ok" && p.icon_url && !fav.querySelector("img")) fav.innerHTML = favImg(p);
  const slot = el.querySelector(".pv, .review-pv");
  if (slot) slot.innerHTML = previewInner(p, thumbClass || "pv-thumb");
  const title = el.querySelector("[data-pvtitle]");
  if (title && p.status === "ok" && p.title) title.textContent = p.title;
}

function paintPreview(row) {
  document.querySelectorAll("[data-purl]").forEach((el) => {
    if (el.dataset.purl === row.key) applyPreview(el, row, el.dataset.pvthumb);
  });
}

// Called after every render that emits cards. Cards whose preview is already
// known are painted immediately (no flicker on re-render); the rest are handed
// to the observer and fetched when they come into view.
function observePreviews() {
  if (!previewObserver && "IntersectionObserver" in window) {
    previewObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        previewObserver.unobserve(e.target);
        queuePreview(e.target.dataset.purl);
      }
    }, { rootMargin: "400px" });   // start fetching just before they scroll in
  }
  document.querySelectorAll("#main [data-purl]").forEach((el) => {
    const known = previews.get(el.dataset.purl);
    if (known) applyPreview(el, known, el.dataset.pvthumb);
    else if (previewObserver) previewObserver.observe(el);
    else queuePreview(el.dataset.purl);   // no IO support: just ask
  });
}

function itemCard(it, acts) {
  const tags = (it.tags || []).map((t) => '<span class="tag">' + esc(t) + "</span>").join("");
  let pills = "";
  if (it.bucket === "rounds") {
    const cls = isRoundOverdue(it) ? "over" : isRoundDue(it) ? "due" : "ok";
    pills = '<span class="pill ' + cls + ' dot">' + (isRoundDue(it) ? "Due " + fmtRel(roundDue(it)) : "Next " + fmtRel(roundDue(it))) + "</span>";
  } else if (it.bucket === "queue") {
    const q = queueOverdue(it) ? "over" : queueSoon(it) ? "due" : "ok";
    const txt = queueOverdue(it) ? "Overdue · " + ageDays(ms(it.added_at)) + "d old"
      : queueSoon(it) ? "Expires " + fmtRel(queueExpires(it))
        : "Read by " + fmtRel(queueExpires(it));
    pills = '<span class="pill ' + q + ' dot">' + txt + "</span>";
  } else if (it.bucket === "archive") {
    const at = ms(it.archived_at) ?? ms(it.added_at);
    pills = archiveOld(it)
      ? '<span class="pill over dot">Aged out · ' + ageDays(at) + "d</span>"
      : '<span class="pill ok dot">Archived ' + fmtRel(at) + "</span>";
  } else if (it.bucket === "explore" && !it.url) {
    pills = '<span class="pill ok">✦ idea</span>';
  }
  if (snoozed(it)) pills += ' <span class="pill ok">Snoozed ' + fmtRel(ms(it.snoozed_until)) + "</span>";
  // Items saved by the extension or bulk-imported often carry no title of their
  // own, and a card reading "news.ycombinator.com" tells you nothing. Borrow
  // the page's real title in that case — but never over a title you typed.
  const p = previewOf(it);
  const ownTitle = !!(it.title && it.title.trim());
  const heading = !ownTitle && p && p.status === "ok" && p.title ? p.title : niceTitle(it);
  const titleAttr = ownTitle ? "" : " data-pvtitle";

  return '<div class="item" data-id="' + it.id + '"' +
      (it.url ? ' data-purl="' + esc(it.url) + '"' : "") + ">" +
    '<div class="fav" data-letter="' + esc(initial(it)) + '">' +
      (p && p.status === "ok" && p.icon_url ? favImg(p) : esc(initial(it))) + "</div>" +
    '<div class="body">' +
      '<div class="title">' + (it.url
        ? '<a href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer" data-act="open"' + titleAttr + ">" + esc(heading) + "</a>"
        : esc(heading)) + "</div>" +
      (it.url ? '<div class="url">' + esc(host(it.url)) + "</div>" : "") +
      (it.url ? '<div class="pv">' + previewInner(p, "pv-thumb") + "</div>" : "") +
      (it.note ? '<div class="note">' + esc(it.note) + "</div>" : "") +
      '<div class="meta">' + pills + tags + "</div>" +
    "</div>" +
    '<div class="acts">' + acts + "</div>" +
  "</div>";
}
function A(act, label, cls) { return '<button class="btn sm ' + (cls || "") + '" data-act="' + act + '">' + label + "</button>"; }

function render() {
  if (!main) return;
  renderNav();
  if (current === "overview") return renderOverview();
  if (current === "inbox") return renderBucket("inbox");
  if (current === "library") return renderLibrary();
  if (current === "rounds") return renderBucket("rounds");
  if (current === "queue") return renderBucket("queue");
  if (current === "explore") return renderExplore();
  if (current === "groups") return renderGroups();
  if (current === "archive") return renderArchive();
  if (current === "playbook") return renderPlaybook();
}

function renderOverview() {
  const a = attn();
  const total = items.length;
  const revN = reviewQueue().length;
  const explN = byBucket("explore").length;
  const exploreNudge = explN ? ('<div class="explore-nudge">' +
      '<span class="txt">✦ <b>' + explN + " interesting idea" + (explN > 1 ? "s" : "") + "</b> waiting in Explore — no rush, whenever you're curious.</span>" +
      '<button class="btn sm" id="ov-surprise">Surprise me</button>' +
      '<button class="btn sm" data-view="explore">Browse</button>' +
    "</div>") : "";
  const cards = [
    { k: a.inbox.length, lbl: "to sort in the <b>Inbox</b>", cls: a.inbox.length ? "warm" : "", go: "inbox" },
    { k: a.due.length, lbl: "<b>Rounds</b> due for a revisit", cls: a.due.length ? "go" : "", go: "rounds" },
    { k: a.over.length, lbl: "<b>Read-later</b> past shelf life", cls: a.over.length ? "hot" : "", go: "queue" },
    { k: a.purge.length, lbl: "aged out in the <b>Archive</b>", cls: a.purge.length ? "warm" : "", go: "archive" },
  ];
  const attnHtml = cards.map((c) =>
    '<button class="attn clickable ' + c.cls + '" data-view="' + c.go + '"><span class="stripe"></span>' +
    '<span class="n">' + c.k + "</span>" +
    '<span class="lbl">' + c.lbl + "</span></button>").join("");

  let body;
  if (total === 0) {
    body = '<div class="empty panel"><div class="panel-pad">' +
      '<div class="big">Your desk is empty — let\'s clear the pile.</div>' +
      "<p>Bring in the bookmarks and open tabs you've been hoarding. They'll land in the Inbox, and you'll sort them a few at a time — not all at once.</p>" +
      '<div class="overview-cta" style="justify-content:center"><button class="btn primary" id="ov-import">⇩ Import your links</button>' +
      '<button class="btn" id="ov-add2">+ Add one by hand</button></div>' +
      "</div></div>";
  } else {
    body = '<div class="overview-cta">' +
        (revN > 0
          ? '<button class="btn primary" id="ov-review">▶ Start review · ' + revN + " item" + (revN > 1 ? "s" : "") + "</button>"
          : '<button class="btn" id="ov-review" disabled style="opacity:.6">✓ Nothing to review — you\'re clear</button>') +
        '<span class="hint">' + total + " link" + (total > 1 ? "s" : "") + " on the desk</span>" +
      "</div>" +
      '<div class="panel panel-pad">' +
        '<label class="field">Quick add — drop a link and sort it later</label>' +
        '<div class="qadd"><input id="ov-url" placeholder="Paste a URL and hit Enter…" autocomplete="off">' +
        '<button class="btn primary" id="ov-quickadd">Add to Inbox</button></div>' +
      "</div>";
  }

  main.innerHTML = '<section class="view active">' +
    '<div class="hero">' +
      '<div class="eyebrow">Keep signal · cut noise</div>' +
      "<h1>What needs your attention</h1>" +
      "<p>Five buckets, each with its own job. The desk surfaces what's due so the rest can sit quietly until it's useful — or ages out on its own.</p>" +
    "</div>" +
    '<div class="attn-grid">' + attnHtml + "</div>" +
    body +
    exploreNudge +
    '<div class="footnote">Your desk syncs to your account, so it follows you to every device you sign in on. Local changes are saved even when you\'re offline and pushed on the next sync. <b>⋯ → Export backup</b> still gives you a portable copy.</div>' +
  "</section>";

  bind("#ov-import", "click", openImport);
  bind("#ov-add2", "click", () => openEdit());
  bind("#ov-review", "click", startReview);
  bind("#ov-quickadd", "click", quickAdd);
  bind("#ov-url", "keydown", (e) => { if (e.key === "Enter") quickAdd(); });
  bind("#ov-surprise", "click", surpriseExplore);
}

async function quickAdd() {
  const el = document.getElementById("ov-url");
  const u = normUrl(el.value);
  if (!u) { toast("Paste a URL first."); return; }
  el.value = "";
  await addItem({ url: u, bucket: "inbox" });
  toast("Added to Inbox.");
  const again = document.getElementById("ov-url");
  if (again) again.focus();
}

function renderBucket(b) {
  const list0 = byBucket(b).slice();
  if (b === "rounds") list0.sort((x, y) => roundDue(x) - roundDue(y));
  else if (b === "queue") list0.sort((x, y) => (ms(x.added_at) ?? 0) - (ms(y.added_at) ?? 0));
  else list0.sort((x, y) => (ms(y.added_at) ?? 0) - (ms(x.added_at) ?? 0));

  const intro = {
    inbox: "Everything unsorted lands here. Give each one a home — or let it go. An inbox is for processing, not for living in.",
    rounds: "Sites you deliberately come back to on a schedule. “Visit” opens it and resets the clock.",
    queue: "Read once, then decide: keep or release. Anything past its shelf life is asking you a question.",
  }[b];

  const acts = () => {
    if (b === "inbox") return A("peek", "▣ Peek", "ghost") + A("keep", "→ Keep") + A("round", "↻ Rounds") + A("later", "⏱ Later") + A("explore", "✦ Explore") + A("edit", "Edit", "ghost") + A("archive", "Archive", "ghost") + A("discard", "Discard", "ghost danger");
    if (b === "rounds") return A("visit", "↗ Visit", "primary") + A("snooze", "Snooze") + A("edit", "Edit", "ghost") + A("retire", "Retire → Library", "ghost") + A("discard", "Discard", "ghost danger");
    if (b === "queue") return A("read", "↗ Read & keep", "primary") + A("release", "Release") + A("snooze", "Snooze") + A("edit", "Edit", "ghost") + A("discard", "Discard", "ghost danger");
    return "";
  };
  const list = list0.length ? ('<div class="list">' + list0.map((it) => itemCard(it, acts(it))).join("") + "</div>") : emptyState(b);
  const head = (b === "inbox" && list0.length > 1)
    ? '<div class="toolbar"><button class="btn primary sm" id="triage-here">▶ Triage these (' + list0.length + ')</button><span class="spacer"></span></div>'
    : "";
  main.innerHTML = '<section class="view active">' +
    '<div class="section-title"><h2>' + BUCKET_LABEL[b] + '</h2><span class="sub">' + list0.length + " item" + (list0.length === 1 ? "" : "s") + "</span></div>" +
    '<p style="color:var(--muted);max-width:64ch;margin:-6px 0 18px">' + intro + "</p>" + head + list + "</section>";
  bind("#triage-here", "click", startReview);
  observePreviews();
}

function renderLibrary() {
  const all = byBucket("library");
  const tags = {};
  all.forEach((it) => (it.tags || []).forEach((t) => { tags[t] = (tags[t] || 0) + 1; }));
  const tagKeys = Object.keys(tags).sort();
  const list0 = all.filter((it) => {
    if (libFilterTag && (it.tags || []).indexOf(libFilterTag) < 0) return false;
    if (libSearch) {
      const s = libSearch.toLowerCase();
      return (niceTitle(it) + " " + (it.url || "") + " " + (it.note || "") + " " + (it.tags || []).join(" ")).toLowerCase().indexOf(s) >= 0;
    }
    return true;
  }).sort((x, y) => (ms(y.added_at) ?? 0) - (ms(x.added_at) ?? 0));
  const acts = () => A("visit-lib", "↗ Open", "primary") + A("round", "↻ Make a round", "ghost") + A("edit", "Edit", "ghost") + A("archive", "Archive", "ghost") + A("discard", "Discard", "ghost danger");
  const tagbar = tagKeys.length
    ? '<div class="filter-tags"><span class="tag' + (!libFilterTag ? " on" : "") + '" data-tag="__all">All</span>' +
      tagKeys.map((t) => '<span class="tag' + (libFilterTag === t ? " on" : "") + '" data-tag="' + esc(t) + '">' + esc(t) + " ·" + tags[t] + "</span>").join("") + "</div>"
    : "";
  const list = list0.length ? ('<div class="list">' + list0.map((it) => itemCard(it, acts(it))).join("") + "</div>") : emptyState("library");
  main.innerHTML = '<section class="view active">' +
    '<div class="section-title"><h2>Library</h2><span class="sub">' + all.length + " kept · findable when you need them</span></div>" +
    '<p style="color:var(--muted);max-width:64ch;margin:-6px 0 18px">Reference you return to on demand — docs, tools, the good stuff. No reminders here; these just need to be findable.</p>' +
    '<div class="toolbar"><input class="search" id="lib-search" placeholder="Search library…" value="' + esc(libSearch) + '"><span class="spacer"></span></div>' +
    tagbar +
    '<div style="height:14px"></div>' + list + "</section>";
  const s = document.getElementById("lib-search");
  if (s) s.addEventListener("input", () => {
    libSearch = s.value;
    const pos = s.selectionStart;
    renderLibrary();
    const n = document.getElementById("lib-search");
    n.focus();
    try { n.setSelectionRange(pos, pos); } catch (e) {}
  });
  observePreviews();
}

function renderExplore() {
  const all = byBucket("explore");
  const tags = {};
  all.forEach((it) => (it.tags || []).forEach((t) => { tags[t] = (tags[t] || 0) + 1; }));
  const tagKeys = Object.keys(tags).sort();
  const list0 = all.filter((it) => {
    if (explFilterTag && (it.tags || []).indexOf(explFilterTag) < 0) return false;
    if (explSearch) {
      const s = explSearch.toLowerCase();
      return (niceTitle(it) + " " + (it.url || "") + " " + (it.note || "") + " " + (it.tags || []).join(" ")).toLowerCase().indexOf(s) >= 0;
    }
    return true;
  }).sort((x, y) => (ms(y.added_at) ?? 0) - (ms(x.added_at) ?? 0));
  const acts = (it) => (it.url ? A("visit-lib", "↗ Open", "primary") + A("later", "⏱ Move to Read-later", "ghost") : "") + A("edit", "Edit", "ghost") + A("discard", "Let go", "ghost danger");
  const tagbar = tagKeys.length
    ? '<div class="filter-tags"><span class="tag' + (!explFilterTag ? " on" : "") + '" data-etag="__all">All</span>' +
      tagKeys.map((t) => '<span class="tag' + (explFilterTag === t ? " on" : "") + '" data-etag="' + esc(t) + '">' + esc(t) + " ·" + tags[t] + "</span>").join("") + "</div>"
    : "";
  const surprise = all.length > 1 ? '<button class="btn sm" id="expl-surprise">✦ Surprise me</button>' : "";
  const list = list0.length ? ('<div class="list">' + list0.map((it) => itemCard(it, acts(it))).join("") + "</div>") : emptyState("explore");
  main.innerHTML = '<section class="view active">' +
    '<div class="section-title"><h2>Explore</h2><span class="sub">' + all.length + " idea" + (all.length === 1 ? "" : "s") + " · no deadline, no guilt</span></div>" +
    '<p style="color:var(--muted);max-width:64ch;margin:-6px 0 18px">Interesting ideas and books you’d love to get to someday — the stuff that’s genuinely fun to imagine, not a chore you’re behind on. Nothing here expires or nags. Dip in when you want a spark.</p>' +
    '<div class="toolbar"><input class="search" id="expl-search" placeholder="Search your ideas…" value="' + esc(explSearch) + '">' + surprise + '<span class="spacer"></span></div>' +
    tagbar +
    '<div style="height:14px"></div>' + list + "</section>";
  const s = document.getElementById("expl-search");
  if (s) s.addEventListener("input", () => {
    explSearch = s.value;
    const pos = s.selectionStart;
    renderExplore();
    const n = document.getElementById("expl-search");
    n.focus();
    try { n.setSelectionRange(pos, pos); } catch (e) {}
  });
  bind("#expl-surprise", "click", surpriseExplore);
  observePreviews();
}

function surpriseExplore() {
  const all = byBucket("explore");
  if (!all.length) { toast("Nothing in Explore yet."); return; }
  explSearch = ""; explFilterTag = null;
  if (current !== "explore") { current = "explore"; render(); }
  const pick = all[Math.floor(Math.random() * all.length)];
  const el = document.querySelector('.item[data-id="' + pick.id + '"]');
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  }
  toast("Here’s one: " + niceTitle(pick));
}

function renderArchive() {
  const list0 = byBucket("archive").sort((x, y) =>
    ((ms(y.archived_at) ?? ms(y.added_at)) ?? 0) - ((ms(x.archived_at) ?? ms(x.added_at)) ?? 0));
  const old = list0.filter(archiveOld);
  const acts = () => A("restore", "↩ Restore", "ghost") + A("discard", "Delete", "ghost danger");
  let head = '<p style="color:var(--muted);max-width:64ch;margin:-6px 0 16px">The hospice. Things you couldn\'t quite delete live here — out of sight, out of your counts. Anything you don\'t pull back within 90 days has earned its deletion.</p>';
  if (old.length) {
    head += '<div class="callout warn"><p><b>' + old.length + " item" + (old.length > 1 ? "s have" : " has") +
      " aged out</b> (90+ days untouched). If you haven't needed them by now, you won't. " +
      '<button class="btn sm danger" id="purge-old" style="margin-left:8px">Clear aged-out (' + old.length + ")</button></p></div>";
  }
  const list = list0.length ? ('<div class="list">' + list0.map((it) => itemCard(it, acts(it))).join("") + "</div>") : emptyState("archive");
  main.innerHTML = '<section class="view active"><div class="section-title"><h2>Archive</h2><span class="sub">' + list0.length + " resting</span></div>" + head + list + "</section>";
  bind("#purge-old", "click", async () => {
    for (const it of old) await deleteItem(it.id);
    await afterMutation();
    toast("Cleared " + old.length + " aged-out link" + (old.length > 1 ? "s" : "") + ".");
  });
  observePreviews();
}

// ---------- Groups (tab sessions) ----------
function renderGroups() {
  const list0 = sessions.slice().sort((x, y) => (ms(y.updated_at) ?? 0) - (ms(x.updated_at) ?? 0));
  let body;
  if (!list0.length) {
    body = '<div class="empty"><div class="big">No saved groups yet.</div>' +
      "<p>A <b>Group</b> is a saved set of browser tabs. Save one from the Signal Desk Chrome extension (“Save this window as a session”), and it shows up here on every device.</p></div>";
  } else {
    body = '<div class="list">' + list0.map((s) => {
      const tabs = s.tabs || [];
      const links = tabs.map((t) =>
        '<li><a href="' + esc(t.url) + '" target="_blank" rel="noopener noreferrer">' + esc(t.title || t.url) + "</a>" +
        (t.groupTitle ? ' <span class="tag">' + esc(t.groupTitle) + "</span>" : "") + "</li>").join("");
      return '<div class="item" data-sid="' + s.id + '">' +
        '<div class="fav">▤</div>' +
        '<div class="body">' +
          '<div class="title">' + esc(s.name || "Untitled group") + "</div>" +
          '<div class="url">' + tabs.length + " tab" + (tabs.length === 1 ? "" : "s") + " · saved " + fmtRel(ms(s.updated_at)) + "</div>" +
          '<ul class="tablist">' + links + "</ul>" +
        "</div>" +
        '<div class="acts">' +
          A("g-openall", "↗ Open all", "primary") +
          A("g-rename", "Rename", "ghost") +
          A("g-delete", "Delete", "ghost danger") +
        "</div>" +
      "</div>";
    }).join("") + "</div>";
  }
  main.innerHTML = '<section class="view active">' +
    '<div class="section-title"><h2>Groups</h2><span class="sub">' + list0.length + " saved session" + (list0.length === 1 ? "" : "s") + "</span></div>" +
    '<p style="color:var(--muted);max-width:64ch;margin:-6px 0 18px">Saved sets of browser tabs, synced with the rest of your desk. Restoring a whole window into its original tab groups needs the Chrome extension — a web page can’t open a window of tabs on its own, so here you get the links.</p>' +
    body + "</section>";
}

function renderPlaybook() {
  main.innerHTML = '<section class="view active playbook">' +
    '<div class="hero">' +
      '<div class="eyebrow">The system, in plain words</div>' +
      "<h1>The Signal Desk Playbook</h1>" +
      '<p class="lede">A link is only worth keeping if it has a job. Sort by the job, give each job its own lifecycle, and let the rest go without guilt. That’s the whole method.</p>' +
    "</div>" +

    '<div class="pb-block">' +
      "<h2>The one rule at capture</h2>" +
      "<p>Saving should cost you three seconds, not thirty. Don’t decide where a link belongs the moment you find it — that friction is why piles form. Just <b>throw it in the Inbox</b> and keep moving. Sorting happens later, in a batch, when your head is in “decide” mode instead of “explore” mode.</p>" +
      '<div class="callout"><p><b>Capture fast, sort slow.</b> The Inbox is a landing strip, never a home. Its only healthy state is on its way to empty.</p></div>' +
    "</div>" +

    '<div class="pb-block">' +
      "<h2>Five buckets, five jobs</h2>" +
      "<p>Most link chaos comes from mixing things that do completely different jobs. A reference doc and a half-read article don’t belong in the same list — one you’ll search for on demand, the other is rotting on a clock. Separate them by job and each becomes easy to manage.</p>" +
      '<div class="bucket-def"><span class="k">Inbox</span><div class="d"><h3>Capture</h3><p>Unsorted arrivals. You process it, you don’t browse it. Goal: back to zero.</p></div></div>' +
      '<div class="bucket-def"><span class="k">Library</span><div class="d"><h3>Reference — return on demand</h3><p>Docs, tools, the genuinely good stuff you’ll come back to when a need arises. <b>No reminders</b> — these just need to be tagged and findable. Kept until a link dies or something better replaces it.</p></div></div>' +
      '<div class="bucket-def"><span class="k">Rounds</span><div class="d"><h3>Revisit on a schedule</h3><p>Things you deliberately check on a cadence — a blog, a dashboard, a forum. The desk tells you what’s due; “Visit” opens it and resets the clock. If you keep snoozing a round, that’s a signal it’s not really a round.</p></div></div>' +
      '<div class="bucket-def"><span class="k">Read-later</span><div class="d"><h3>Consume once, then decide</h3><p>Read it, then either promote it to the Library or release it. Every item has a <b>shelf life</b>. Past it, the item is asking you a question: read it now, or admit you won’t.</p></div></div>' +
      '<div class="bucket-def"><span class="k">Explore</span><div class="d"><h3>Someday, for the joy of it</h3><p>Interesting ideas and books you’d love to get to — with <b>no deadline and no guilt</b>. Unlike Read-later, nothing here expires or nags, and it’s kept out of the weekly review and the attention counts on purpose. It’s a curiosity shelf you dip into for a spark, not a queue you’re behind on. A URL is optional — a book title or a one-line idea is enough. Hit <b>Surprise me</b> to pull one at random.</p></div></div>' +
    "</div>" +

    '<div class="pb-block">' +
      "<h2>The weekly review — 10 minutes</h2>" +
      "<p>The system only works if you look at it on a rhythm. Once a week, hit <b>Start review</b> and let it walk you through only what needs a decision: unsorted Inbox items, read-laters past their shelf, and rounds that are due. One card at a time, quick verdicts, done. Small regular passes beat a heroic cleanup you’ll never schedule.</p>" +
      "<ul>" +
        "<li><b>Inbox → a home or the bin.</b> Every item leaves the Inbox with a decision.</li>" +
        "<li><b>Overdue read-laters → read or release.</b> No third option. “Someday” is not a plan.</li>" +
        "<li><b>Rounds due → visit or question the round.</b> If you don’t want to open it, maybe it shouldn’t be a round.</li>" +
      "</ul>" +
      '<p style="color:var(--faint);font-size:13.5px">Once a month, also glance at the Archive and clear what’s aged out.</p>' +
    "</div>" +

    '<div class="pb-block">' +
      "<h2>The discard rule — beating guilt-hoarding</h2>" +
      "<p>We keep links “just in case they help someday.” They almost never do — and the cost isn’t zero. Every dead-weight link is search noise, a little more overwhelm, and a quiet nag that you’re falling behind. Run any doubtful item through this, in order:</p>" +
      "<ol>" +
        "<li><b>The re-find test.</b> If you needed it next week, could you find it again in two minutes of searching? For most “might be useful” links the answer is yes — the open web is your storage. <b>Let it go.</b></li>" +
        "<li><b>The next-action test.</b> Name a specific situation in the next 30–90 days where you’ll actually use it. If you can’t name one concretely, you’re keeping it out of guilt, not utility. <b>Let it go.</b></li>" +
        "<li><b>The shelf-life vote.</b> A read-later you’ve ignored past its shelf life — you’ve already voted with your behavior. Respect the vote. Read it now or release it.</li>" +
      "</ol>" +
      '<div class="callout warn"><p><b>Can’t bring yourself to delete? Use the Archive as a hospice.</b> It’s a one-way holding pen you never browse — out of your counts, out of your attention. Anything you don’t deliberately pull back within 90 days deletes itself. This is the trick: it splits the <i>decision</i> to let go from the <i>act</i> of deleting, so guilt never gets a veto. You’re not throwing it away — you’re letting it prove, by your own silence, that you never needed it.</p></div>' +
      '<h3>“But some things I keep because I genuinely want to”</h3>' +
      "<p>Right — and that’s the whole point of <b>Explore</b>. The enemy here is <i>guilt</i>: things you feel you <b>should</b> get to. Genuine curiosity is the opposite — a book or idea you actually <b>want</b> to explore someday, that’s fun to imagine getting to. That belongs in Explore, deliberately, with no clock and no nag. The honest test is desire versus obligation: if you’d only keep it because letting go feels bad, that’s the Archive. If keeping it genuinely delights you, that’s Explore. Naming which one it is <i>is</i> the anti-hoarding move — the pile forms when everything hides in the fuzzy middle of “maybe.”</p>" +
    "</div>" +

    '<div class="pb-block">' +
      "<h2>Keeping it alive</h2>" +
      "<p>Two habits keep the desk honest: capture everything to the Inbox without thinking, and never skip the weekly review. The reminder you’ll get is just a nudge to open the desk and run one pass. Miss a week and nothing breaks — the piles just wait, and the review the following week is a little longer.</p>" +
      '<div class="footnote">Your desk lives in your account and syncs to every device you sign in on — including the Chrome extension, which can capture tabs and mirror a bookmark folder. Edits made offline are kept locally and pushed when you reconnect. An export from the ⋯ menu is still the copy that travels outside the system.</div>' +
    "</div>" +
  "</section>";
}

function emptyState(b) {
  const msgs = {
    inbox: ["Inbox zero.", "Nothing to sort. Capture new links fast — everything lands here first, and you decide later."],
    library: ["Nothing kept yet.", "When you sort an Inbox item as <b>Keep</b>, it lands here as reference."],
    rounds: ["No rounds set.", "Add a site you want to revisit on a schedule — a blog, a dashboard, a forum."],
    queue: ["Nothing to read.", "Send an article here to read later. It’ll nudge you before it goes stale."],
    explore: ["Nothing to explore yet.", "Park a book you’d love to read someday, an idea you’re curious about, or a link worth a slow look — no deadline, ever. Use <b>+ Add → Explore</b>; a URL is optional."],
    archive: ["The hospice is empty.", "When you can’t bring yourself to delete something, send it here instead of the Library."],
  }[b];
  return '<div class="empty"><div class="big">' + msgs[0] + "</div><p>" + msgs[1] + "</p></div>";
}

// ============================================================================
// Actions
// ============================================================================
async function handleAct(act, id) {
  const it = find(id);
  if (!it && act !== "open") return;
  switch (act) {
    case "open": return;
    case "keep": await moveTo(it, "library"); toast("Kept in Library."); return;
    case "round": openRoundPrompt(it); return;
    case "later": await moveTo(it, "queue"); toast("Added to Read-later."); return;
    case "explore": await moveTo(it, "explore"); toast("Parked in Explore — no rush."); return;
    case "peek": peek(it.url); return;
    case "visit":
    case "visit-lib":
      peek(it.url);
      if (it.bucket === "rounds") {
        await upsertItem({ id: it.id, last_visited: iso(), snoozed_until: null });
        await afterMutation();
      }
      return;
    case "read":
      peek(it.url);
      await moveTo(it, "library");
      toast("Read → kept in Library.");
      return;
    case "release": await removeItem(id); toast("Released. One less thing."); return;
    case "snooze": await snoozeItem(it); toast("Snoozed 2 weeks."); return;
    case "retire": await moveTo(it, "library"); toast("Retired to Library."); return;
    case "archive": await moveTo(it, "archive"); toast("Sent to the Archive hospice."); return;
    case "restore": await moveTo(it, "inbox"); toast("Restored to Inbox."); return;
    case "discard": await removeItem(id); toast("Discarded."); return;
    case "edit": openEdit(it); return;
  }
}

async function handleSessionAct(act, sid) {
  const s = sessions.find((x) => x.id === sid);
  if (!s) return;
  if (act === "g-openall") {
    const tabs = s.tabs || [];
    if (!tabs.length) { toast("This group has no tabs."); return; }
    let blocked = 0;
    for (const t of tabs) {
      const w = window.open(t.url, "_blank", "noopener");
      if (!w) blocked++;
    }
    toast(blocked ? "Your browser blocked " + blocked + " pop-up" + (blocked === 1 ? "" : "s") + " — allow pop-ups for this site." : "Opened " + tabs.length + " tabs.");
    return;
  }
  if (act === "g-rename") {
    const name = prompt("Rename this group:", s.name || "");
    if (name == null) return;
    await upsertSession({ id: s.id, name: name.trim() });
    await afterMutation();
    toast("Renamed.");
    return;
  }
  if (act === "g-delete") {
    if (!confirm('Delete the group "' + (s.name || "Untitled") + '"? This removes it from every device.')) return;
    await upsertSession({ id: s.id, deleted: true });
    await afterMutation();
    toast("Group deleted.");
  }
}

// ============================================================================
// Add / Edit modal
// ============================================================================
let editing = null, pendingBucket = "inbox";
function setBucketSeg(b) {
  pendingBucket = b;
  document.querySelectorAll("#f-bucket button").forEach((btn) => btn.classList.toggle("on", btn.getAttribute("data-b") === b));
  document.getElementById("f-cadence-row").style.display = b === "rounds" ? "flex" : "none";
  document.getElementById("f-shelf-row").style.display = b === "queue" ? "flex" : "none";
  document.getElementById("f-explore-hint").style.display = b === "explore" ? "block" : "none";
  document.getElementById("f-url-label").textContent = b === "explore" ? "URL (optional)" : "URL";
}
function openEdit(it) {
  editing = it || null;
  document.getElementById("editTitle").textContent = it ? "Edit link" : "Add a link";
  document.getElementById("f-url").value = it && it.url ? it.url : "";
  document.getElementById("f-title").value = it && it.title ? it.title : "";
  document.getElementById("f-tags").value = it && it.tags ? it.tags.join(", ") : "";
  document.getElementById("f-note").value = it && it.note ? it.note : "";
  setBucketSeg(it ? it.bucket : "inbox");
  if (it && it.cadence_days) document.getElementById("f-cadence").value = String(it.cadence_days);
  if (it && it.shelf_days) document.getElementById("f-shelf").value = String(it.shelf_days);
  document.getElementById("editOverlay").classList.add("open");
  setTimeout(() => document.getElementById("f-url").focus(), 30);
}
function openRoundPrompt(it) {
  openEdit(it);
  setBucketSeg("rounds");
}

async function saveEdit() {
  const url = normUrl(document.getElementById("f-url").value);
  const titleVal = document.getElementById("f-title").value.trim();
  if (!url && !(pendingBucket === "explore" && titleVal)) {
    toast(pendingBucket === "explore" ? "Add a URL or a title." : "A URL is required.");
    return;
  }
  const data = {
    url: url || null,
    title: titleVal,
    tags: tagList(document.getElementById("f-tags").value),
    note: document.getElementById("f-note").value.trim(),
    cadence_days: parseInt(document.getElementById("f-cadence").value, 10),
    shelf_days: parseInt(document.getElementById("f-shelf").value, 10),
  };
  if (editing) {
    const target = editing;
    const bucketChanged = pendingBucket !== target.bucket;
    const patch = { id: target.id, url: data.url, title: data.title, tags: data.tags, note: data.note };
    if (!bucketChanged) {
      if (pendingBucket === "rounds") patch.cadence_days = data.cadence_days;
      if (pendingBucket === "queue") patch.shelf_days = data.shelf_days;
      await upsertItem(patch);
      await afterMutation();
    } else {
      await upsertItem(patch);
      await moveTo(target, pendingBucket, data);
    }
    toast("Saved.");
  } else {
    await addItem({
      url: data.url, title: data.title, tags: data.tags, note: data.note,
      bucket: pendingBucket, cadence_days: data.cadence_days, shelf_days: data.shelf_days,
    });
    toast("Added to " + BUCKET_LABEL[pendingBucket] + ".");
  }
  closeOverlays();
}

// ============================================================================
// Import
// ============================================================================
function openImport() {
  document.getElementById("imp-text").value = "";
  document.getElementById("imp-file").value = "";
  document.getElementById("importOverlay").classList.add("open");
}
function extractBookmarks(html) {
  const out = [];
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (!/^https?:/i.test(href)) return;
      const add = a.getAttribute("add_date");
      out.push({
        url: href,
        title: (a.textContent || "").trim(),
        added_at: add ? iso(parseInt(add, 10) * 1000) : iso(),
      });
    });
  } catch (e) {}
  return out;
}
async function importUrls(arr) {
  const existing = {};
  items.forEach((it) => { if (it.url) existing[it.url] = 1; });
  let n = 0;
  for (const o of arr) {
    const u = normUrl(o.url);
    if (!u || existing[u]) continue;
    existing[u] = 1;
    await upsertItem({
      url: u, title: o.title || "", note: "", tags: [],
      bucket: "inbox", added_at: o.added_at || iso(),
    });
    n++;
  }
  if (n) await afterMutation();
  return n;
}
async function doImport() {
  const file = document.getElementById("imp-file").files[0];
  const text = document.getElementById("imp-text").value;
  if (file) {
    const reader = new FileReader();
    reader.onload = async () => {
      const n = await importUrls(extractBookmarks(reader.result));
      closeOverlays();
      toast("Imported " + n + " link" + (n === 1 ? "" : "s") + " to Inbox.");
    };
    reader.readAsText(file);
  } else {
    const urls = text.split(/[\n\r]+/).map((s) => s.trim()).filter(Boolean);
    const n = await importUrls(urls.map((u) => ({ url: u })));
    closeOverlays();
    toast(n ? "Imported " + n + " link" + (n === 1 ? "" : "s") + " to Inbox." : "No URLs found.");
  }
}

// ============================================================================
// Review mode
// ============================================================================
let revList = [], revIdx = 0, revTotal = 0;
function startReview() {
  revList = reviewQueue(); revTotal = revList.length; revIdx = 0;
  if (!revTotal) { toast("Nothing to review — you're clear."); return; }
  document.getElementById("reviewOverlay").classList.add("open");
  renderReview();
}
function renderReview() {
  if (revIdx >= revList.length) {
    document.getElementById("rev-bar").style.width = "100%";
    document.getElementById("rev-card").innerHTML =
      '<div class="review-main" style="text-align:center;padding:44px 22px"><div class="title">Desk cleared.</div>' +
      '<div class="note" style="margin-top:10px">You processed everything that needed a decision. That’s the whole game — small, regular passes.</div></div>' +
      '<div class="review-acts" style="justify-content:center"><button class="btn primary" data-close>Done</button></div>';
    render();
    return;
  }
  const cur = revList[revIdx], it = cur.it;
  document.getElementById("rev-bar").style.width = Math.round((revIdx / revTotal) * 100) + "%";
  let acts;
  if (it.bucket === "inbox") {
    acts = A("r-open", "▣ Peek", "ghost") + A("r-keep", "→ Keep", "primary") + A("r-round", "↻ Rounds") + A("r-later", "⏱ Read-later") + A("r-explore", "✦ Explore") + A("r-archive", "Archive", "ghost") + A("r-discard", "Discard", "ghost danger");
  } else if (it.bucket === "queue") {
    acts = A("r-open", "↗ Read it", "primary") + A("r-keep", "Keep in Library") + A("r-snooze", "Snooze 2w") + A("r-discard", "Release", "ghost danger");
  } else {
    acts = A("r-open", "↗ Visit", "primary") + A("r-snooze", "Snooze 2w") + A("r-retire", "Retire → Library") + A("r-discard", "Drop the round", "ghost danger");
  }
  // The review screen is where "what even is this?" costs the most time, so it
  // gets the full preview — and the next card's is fetched now, so advancing
  // never waits on the network.
  const pv = previewOf(it);
  const ownTitle = !!(it.title && it.title.trim());
  const heading = !ownTitle && pv && pv.status === "ok" && pv.title ? pv.title : niceTitle(it);
  if (it.url) queuePreview(it.url);
  const next = revList[revIdx + 1];
  if (next && next.it.url) queuePreview(next.it.url);

  document.getElementById("rev-card").innerHTML =
    '<div class="review-reason">◆ ' + esc(cur.reason) + "</div>" +
    '<div class="review-main"' + (it.url ? ' data-purl="' + esc(it.url) + '" data-pvthumb="review-thumb"' : "") + ">" +
      '<div class="title"' + (ownTitle ? "" : " data-pvtitle") + ">" + esc(heading) + "</div>" +
      '<div class="url">' + esc(it.url || "") + "</div>" +
      (it.url ? '<div class="review-pv">' + previewInner(pv, "review-thumb") + "</div>" : "") +
      (it.note ? '<div class="note">' + esc(it.note) + "</div>" : "") +
      '<div class="review-rule"><h4>Before you keep it — the honest test</h4><ol>' +
        "<li><b>Re-find test.</b> If you needed this next week, could you find it again in two minutes of search? If yes, you don’t need to store it. Let it go.</li>" +
        "<li><b>Next-action test.</b> Name a specific moment in the next month or two when you’ll actually use it. If you can’t name one, that’s guilt talking, not usefulness.</li>" +
        "<li><b>Can’t let go?</b> Send it to the <b>Archive</b>, not the Library. If you never pull it back, it deletes itself in 90 days — no guilt required.</li>" +
        "<li><b>Genuinely want it (not “should”)?</b> If it truly excites you for someday, that’s <b>Explore</b> — no clock, no guilt. Only keeping it out of obligation? That’s the Archive.</li>" +
      "</ol></div>" +
    "</div>" +
    '<div class="review-acts">' + acts + "</div>";
}
async function reviewAct(act) {
  const entry = revList[revIdx];
  if (!entry) return;
  const it = entry.it;
  switch (act) {
    case "r-open": peek(it.url); return;
    case "r-keep": await moveTo(it, "library"); break;
    case "r-round": await moveTo(it, "rounds"); break;
    case "r-later": await moveTo(it, "queue"); break;
    case "r-explore": await moveTo(it, "explore"); break;
    case "r-archive": await moveTo(it, "archive"); break;
    case "r-retire": await moveTo(it, "library"); break;
    case "r-snooze": await snoozeItem(it); break;
    case "r-discard": await removeItem(it.id); break;
  }
  revIdx++;
  renderReview();
}

// ============================================================================
// Export / restore
// ============================================================================
async function exportJSON() {
  const payload = {
    exported_at: iso(),
    items: await Store.all("items"),
    sessions: await Store.all("sessions"),
  };
  const json = JSON.stringify(payload, null, 2);
  const filename = "signal-desk-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  try {
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast("Backup downloaded.");
    return;
  } catch (e) { /* fall through */ }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(json);
      toast("Backup copied to clipboard — paste into a .json file to keep it.");
      return;
    } catch (e) {}
  }
  showBackupText(json);
}
function showBackupText(json) {
  const o = document.createElement("div");
  o.className = "overlay open";
  o.innerHTML = '<div class="modal"><div class="modal-head"><h3>Copy your backup</h3><button class="btn ghost icon-btn" data-x>✕</button></div>' +
    '<div class="modal-body"><p style="color:var(--muted);margin:0">Select all of this and save it into a file named <span class="mono">signal-desk-backup.json</span>.</p>' +
    '<textarea readonly style="min-height:200px" class="mono"></textarea></div>' +
    '<div class="modal-foot"><button class="btn primary" data-x>Done</button></div></div>';
  o.querySelector("textarea").value = json;
  document.body.appendChild(o);
  o.querySelector("textarea").select();
  o.addEventListener("click", (e) => { if (e.target === o || e.target.hasAttribute("data-x")) o.remove(); });
}
function importJSONFile() {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = ".json";
  inp.onchange = () => {
    const f = inp.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = async () => {
      let parsed;
      try {
        parsed = JSON.parse(r.result);
        if (!parsed.items) throw new Error("no items");
      } catch (e) {
        toast("That doesn’t look like a Signal Desk backup.");
        return;
      }
      // MERGE, not replace. A destructive replace would tombstone rows on every
      // synced device; last-write-wins then decides per item.
      if (!confirm("Merge " + parsed.items.length + " links from this backup into your desk?\n\nExisting items with the same id are updated only if the backup copy is newer.")) return;
      let n = 0;
      for (const raw of parsed.items) {
        if (!raw || !raw.id) continue;
        const existing = await Store.get("items", raw.id);
        if (existing && ms(existing.updated_at) >= ms(raw.updated_at)) continue;
        await upsertItem({
          id: raw.id, url: raw.url ?? null, title: raw.title || "", note: raw.note || "",
          tags: raw.tags || [], bucket: raw.bucket || "inbox",
          cadence_days: raw.cadence_days ?? null, last_visited: raw.last_visited ?? null,
          shelf_days: raw.shelf_days ?? null, added_at: raw.added_at || iso(),
          archived_at: raw.archived_at ?? null, snoozed_until: raw.snoozed_until ?? null,
          deleted: !!raw.deleted,
        });
        n++;
      }
      for (const raw of parsed.sessions || []) {
        if (!raw || !raw.id) continue;
        await upsertSession({ id: raw.id, name: raw.name || "", tabs: raw.tabs || [], deleted: !!raw.deleted });
      }
      await afterMutation();
      toast("Merged " + n + " item" + (n === 1 ? "" : "s") + " from the backup.");
    };
    r.readAsText(f);
  };
  inp.click();
}

// ============================================================================
// Theme
// ============================================================================
const THEMES = ["system", "light", "dark"];
const THEME_LBL = { system: "System", light: "Light", dark: "Dark" };
function applyTheme() {
  const t = prefs.theme || "system";
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  const el = document.getElementById("themeLabel");
  if (el) el.textContent = THEME_LBL[t];
}
function cycleTheme() {
  const i = THEMES.indexOf(prefs.theme || "system");
  prefs.theme = THEMES[(i + 1) % 3];
  savePrefs();
  applyTheme();
}

// ============================================================================
// Plumbing
// ============================================================================
function go(v) { current = v; window.scrollTo(0, 0); render(); }
function closeOverlays() {
  document.querySelectorAll(".overlay.open").forEach((o) => o.classList.remove("open"));
  editing = null;
}

function wireStaticHandlers() {
  main = document.getElementById("main");

  // Preview images come from other people's servers and some of them 404 or
  // hotlink-block. A favicon that fails falls back to the letter square it
  // replaced; a thumbnail that fails just leaves. `error` doesn't bubble, so
  // this listens in the capture phase.
  document.addEventListener("error", (e) => {
    const img = e.target;
    if (!img || img.tagName !== "IMG") return;
    const fav = img.closest(".fav");
    if (fav) { fav.textContent = fav.dataset.letter || "?"; return; }
    if (img.classList.contains("pv-thumb") || img.classList.contains("review-thumb")) img.remove();
  }, true);

  main.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) {
      const act = b.getAttribute("data-act");
      if (act === "open") return;
      e.preventDefault();
      const sessCard = b.closest("[data-sid]");
      if (sessCard) { handleSessionAct(act, sessCard.getAttribute("data-sid")); return; }
      const card = b.closest("[data-id]");
      handleAct(act, card ? card.getAttribute("data-id") : null);
      return;
    }
    const v = e.target.closest("[data-view]");
    if (v) { go(v.getAttribute("data-view")); return; }
    const t = e.target.closest("[data-tag]");
    if (t) { const tag = t.getAttribute("data-tag"); libFilterTag = tag === "__all" ? null : tag; renderLibrary(); return; }
    const et = e.target.closest("[data-etag]");
    if (et) { const etag = et.getAttribute("data-etag"); explFilterTag = etag === "__all" ? null : etag; renderExplore(); }
  });

  document.getElementById("nav").addEventListener("click", (e) => {
    const v = e.target.closest("[data-view]");
    if (!v) return;
    const dest = v.getAttribute("data-view");
    if (dest !== "library") { libSearch = ""; libFilterTag = null; }
    if (dest !== "explore") { explSearch = ""; explFilterTag = null; }
    go(dest);
  });

  document.querySelectorAll("#f-bucket button").forEach((btn) =>
    btn.addEventListener("click", () => setBucketSeg(btn.getAttribute("data-b"))));
  document.getElementById("saveItem").addEventListener("click", saveEdit);
  document.getElementById("addBtn").addEventListener("click", () => openEdit());
  document.getElementById("doImport").addEventListener("click", doImport);

  document.getElementById("rev-card").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    reviewAct(b.getAttribute("data-act"));
  });
  document.getElementById("rev-skip").addEventListener("click", () => { revIdx++; renderReview(); });

  const menu = document.getElementById("menu");
  document.getElementById("menuBtn").addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("open"); });
  document.addEventListener("click", () => menu.classList.remove("open"));
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-m]");
    if (!b) return;
    const m = b.getAttribute("data-m");
    if (m === "import") openImport();
    if (m === "export") exportJSON();
    if (m === "importjson") importJSONFile();
    if (m === "sync") { doSync({ quiet: false }); }
    if (m === "logout") doLogout();
    if (m === "theme") { cycleTheme(); return; }
    menu.classList.remove("open");
  });

  // Delegated, not a one-shot querySelectorAll: some [data-close] buttons are
  // rendered later (the review "Desk cleared" card), and a boot-time binding
  // would leave those dead.
  document.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeOverlays(); });
  document.querySelectorAll(".overlay").forEach((o) =>
    o.addEventListener("mousedown", (e) => { if (e.target === o) closeOverlays(); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeOverlays(); });

  // auth gate
  document.getElementById("authTabLogin").addEventListener("click", () => setAuthMode("login"));
  document.getElementById("authTabSignup").addEventListener("click", () => setAuthMode("signup"));
  document.getElementById("authSubmit").addEventListener("click", submitAuth);
  document.getElementById("authForm").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });
}

// ---------- boot ----------
async function boot() {
  loadPrefs();
  applyTheme();
  wireStaticHandlers();

  if (!isLoggedIn()) { showAuth(); return; }
  showApp();
  await reloadFromCache();   // render from cache first — instant, works offline
  // Previews the browser already knows, so the first paint has them: a card
  // that pops its icon in a beat later reads as a page still loading.
  try { for (const [k, v] of await loadPreviews()) previews.set(k, v); } catch (e) {}
  render();
  await doSync({ quiet: false });

  setInterval(() => doSync(), 60000);
  window.addEventListener("online", () => doSync({ quiet: false }));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) doSync(); });
}

boot();
