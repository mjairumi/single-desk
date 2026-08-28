"""M3 acceptance check — the web app, driven in a real browser.

Covers the milestone check from docs/ROADMAP.md verbatim: sign up on the web
app; add / edit / delete items; reload -> state persists; open a SECOND browser
context signed into the same account -> changes propagate both ways, including
tombstones. Also guards the ported features (review mode, Explore's url-less
items, Groups, the Playbook) against regressions.

Run it against a LOCAL server -- it signs up throwaway accounts:

    cd backend && source .venv/bin/activate
    pip install playwright && playwright install chromium
    uvicorn app.main:app --port 8000     # terminal 1
    python tests/web_e2e.py             # terminal 2
"""
import os, sys, uuid
from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8000")
EMAIL = f"web+{uuid.uuid4().hex[:8]}@example.com"
PW = "supersecret1"
fails = []


def check(label, cond, extra=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"   {extra}" if extra and not cond else ""))
    if not cond:
        fails.append(label)


def errors_of(page):
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errs.append(str(e)))
    return errs


with sync_playwright() as p:
    br = p.chromium.launch()

    # ---------- device A ----------
    a = br.new_context()
    pa = a.new_page()
    ea = errors_of(pa)
    pa.goto(BASE)
    pa.wait_for_selector("#authGate", state="visible", timeout=10000)
    check("auth gate blocks the app when logged out", pa.is_hidden("#appShell"))

    pa.click("#authTabSignup")
    pa.fill("#authEmail", EMAIL)
    pa.fill("#authPassword", PW)
    pa.click("#authSubmit")
    pa.wait_for_selector("#appShell", state="visible", timeout=15000)
    check("signup logs in and reveals the app", pa.is_visible("#appShell"))

    # A brand-new desk shows the empty state (no quick-add box yet), so the
    # first item comes from the + Add modal.
    check("empty desk shows the onboarding empty state", pa.is_visible("#ov-import"))
    pa.click("#addBtn")
    pa.wait_for_selector("#editOverlay.open")
    pa.fill("#f-url", "example.com/alpha")
    pa.click("#saveItem")
    pa.wait_for_timeout(700)

    # now that the desk is non-empty, the overview quick-add appears
    pa.click('[data-view="overview"]')
    pa.wait_for_selector("#ov-url", timeout=10000)
    check("quick-add box appears once the desk is non-empty", pa.is_visible("#ov-url"))
    pa.click('[data-view="inbox"]')
    pa.wait_for_selector(".item", timeout=10000)
    check("quick-add creates an item in Inbox", pa.locator(".item").count() == 1)

    # move it to Library ("Keep")
    pa.click('.item [data-act="keep"]')
    pa.wait_for_timeout(600)
    pa.click('[data-view="library"]')
    pa.wait_for_selector(".item", timeout=10000)
    check("Keep moves the item to Library", pa.locator(".item").count() == 1)

    # add an Explore item with no URL (null-url path)
    pa.click("#addBtn")
    pa.wait_for_selector("#editOverlay.open")
    pa.click('#f-bucket button[data-b="explore"]')
    pa.fill("#f-title", "A book with no URL")
    pa.click("#saveItem")
    pa.wait_for_timeout(600)
    pa.click('[data-view="explore"]')
    pa.wait_for_selector(".item", timeout=10000)
    check("Explore accepts a title-only item (url = null)",
          pa.locator(".item").count() == 1 and "idea" in pa.inner_text(".item .meta"))

    # let the debounced sync flush
    pa.wait_for_timeout(2500)

    # ---------- reload persistence ----------
    pa.reload()
    pa.wait_for_selector("#appShell", state="visible", timeout=15000)
    pa.click('[data-view="library"]')
    pa.wait_for_selector(".item", timeout=10000)
    check("state survives a reload (still logged in)", pa.locator(".item").count() == 1)

    # ---------- device B: a separate browser context, same account ----------
    b = br.new_context()
    pb = b.new_page()
    eb = errors_of(pb)
    pb.goto(BASE)
    pb.wait_for_selector("#authGate", state="visible", timeout=10000)
    pb.fill("#authEmail", EMAIL)
    pb.fill("#authPassword", PW)
    pb.click("#authSubmit")
    pb.wait_for_selector("#appShell", state="visible", timeout=15000)
    pb.click('[data-view="library"]')
    pb.wait_for_selector(".item", timeout=10000)
    check("device B pulls device A's Library item", pb.locator(".item").count() == 1)
    pb.click('[data-view="explore"]')
    pb.wait_for_selector(".item", timeout=10000)
    check("device B pulls the url-less Explore item", pb.locator(".item").count() == 1)

    # ---------- edit on B, verify it reaches A ----------
    pb.click('[data-view="library"]')
    pb.wait_for_selector(".item")
    pb.click('.item [data-act="edit"]')
    pb.wait_for_selector("#editOverlay.open")
    pb.fill("#f-title", "Renamed on device B")
    pb.click("#saveItem")
    pb.wait_for_timeout(2500)

    pa.click('[data-view="overview"]')
    pa.evaluate("document.querySelector('[data-m=\"sync\"]').click()")
    pa.wait_for_timeout(2000)
    pa.click('[data-view="library"]')
    pa.wait_for_selector(".item", timeout=10000)
    check("edit on B propagates to A", "Renamed on device B" in pa.inner_text(".item"))

    # ---------- delete on A, verify tombstone reaches B ----------
    pa.click('.item [data-act="discard"]')
    pa.wait_for_timeout(2500)
    pb.evaluate("document.querySelector('[data-m=\"sync\"]').click()")
    pb.wait_for_timeout(2000)
    pb.click('[data-view="library"]')
    pb.wait_for_timeout(800)
    check("delete on A tombstones on B", pb.locator(".item").count() == 0)

    # ---------- review mode still works ----------
    pa.click('[data-view="overview"]')
    pa.wait_for_timeout(300)
    pa.fill("#ov-url", "example.com/review-me")
    pa.click("#ov-quickadd")
    pa.wait_for_timeout(700)
    pa.click("#ov-review")
    pa.wait_for_selector("#reviewOverlay.open", timeout=5000)
    check("review overlay opens with the queued item", "Unsorted" in pa.inner_text("#rev-card"))
    pa.click('#rev-card [data-act="r-keep"]')
    pa.wait_for_timeout(700)
    check("review action advances to the cleared state", "Desk cleared" in pa.inner_text("#rev-card"))
    pa.click('#rev-card [data-close]')

    # ---------- groups view renders ----------
    pa.click('[data-view="groups"]')
    pa.wait_for_timeout(400)
    check("Groups view renders", "Groups" in pa.inner_text("h2"))

    # ---------- playbook intact ----------
    pa.click('[data-view="playbook"]')
    pa.wait_for_timeout(400)
    txt = pa.inner_text("main")
    check("Playbook content preserved",
          "Five buckets, five jobs" in txt and "discard rule" in txt.lower())

    # ---------- logout returns to the gate ----------
    pa.evaluate("document.querySelector('[data-m=\"logout\"]').click()")
    pa.wait_for_selector("#authGate", state="visible", timeout=10000)
    check("logout returns to the auth gate", pa.is_hidden("#appShell"))

    real_errors = [e for e in (ea + eb) if "favicon" not in e.lower()]
    check("no console/page errors", not real_errors, extra=str(real_errors[:3]))

    br.close()

print()
if fails:
    print(f"FAILED ({len(fails)}): " + "; ".join(fails))
    sys.exit(1)
print("ALL M3 CHECKS PASSED")
