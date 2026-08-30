"""Link previews, driven in a real browser.

Covers the card preview feature end to end: the server-side fetch + cache
(app/preview.py, app/routers/preview.py) and the lazy, viewport-driven client
that paints it (the "Link previews" section of app/static/app.js).

What it proves:
  * a saved link grows a favicon, a description and an og:image thumbnail;
  * an item with no title of its own borrows the page's real title, and one you
    typed yourself is never overwritten;
  * requests are batched and capped, not one-per-card;
  * a reload paints from the IndexedDB cache without re-asking the server;
  * the review screen — where identifying a link matters most — shows it too;
  * a URL that cannot be fetched degrades to the plain card, no broken image.

Needs OUTBOUND NETWORK: it previews real public pages, because the whole point
is scraping real-world markup.

    cd backend && source .venv/bin/activate
    pip install playwright && playwright install chromium
    uvicorn app.main:app --port 8000     # terminal 1
    python tests/preview_e2e.py          # terminal 2
"""
import json
import os
import sys
import uuid

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8000")
EMAIL = f"pv+{uuid.uuid4().hex[:8]}@example.com"
PW = "supersecret1"

# Real pages with rich, stable Open Graph tags.
RICH_URL = "https://github.com/pallets/flask"
PLAIN_URL = "https://example.com"
DEAD_URL = "https://nope-9f3a2b7c.example"

fails = []


def check(label, cond, extra=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"   {extra}" if extra and not cond else ""))
    if not cond:
        fails.append(label)


def add_item(page, url, title=None, bucket=None):
    page.click("#addBtn")
    page.wait_for_selector("#editOverlay.open")
    # openEdit() focuses #f-url on a 30ms timer; filling before that lands can
    # let the deferred focus steal the next fill and append it to the URL.
    page.wait_for_timeout(120)
    page.fill("#f-url", url)
    if bucket:
        page.click(f'#f-bucket button[data-b="{bucket}"]')
    if title:
        page.fill("#f-title", title)
    page.click("#saveItem")
    page.wait_for_timeout(500)


def card_for(page, url):
    """The rendered card for a URL (data-purl carries the item's own spelling)."""
    return page.locator(f'.item[data-purl="{url}"]')


with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context()
    page = ctx.new_page()

    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    # Record every preview request so we can assert on batching and caching.
    preview_calls = []

    def on_request(req):
        if req.url.endswith("/api/preview") and req.method == "POST":
            try:
                preview_calls.append(json.loads(req.post_data or "{}").get("urls", []))
            except Exception:
                preview_calls.append([])

    page.on("request", on_request)

    # ---------- sign up ----------
    page.goto(BASE)
    page.wait_for_selector("#authGate", state="visible", timeout=10000)
    page.click("#authTabSignup")
    page.fill("#authEmail", EMAIL)
    page.fill("#authPassword", PW)
    page.click("#authSubmit")
    page.wait_for_selector("#appShell", state="visible", timeout=15000)

    # ---------- a link with rich metadata ----------
    add_item(page, RICH_URL)
    page.click('[data-view="inbox"]')
    page.wait_for_selector(".item", timeout=10000)

    rich = card_for(page, RICH_URL)
    rich.locator(".pv-desc").wait_for(timeout=20000)
    check("card gains a description from og:description", rich.locator(".pv-desc").inner_text().strip() != "")
    check("card gains an og:image thumbnail", rich.locator("img.pv-thumb").count() == 1)
    check("card gains a favicon in the .fav square", rich.locator(".fav img").count() == 1)
    check("thumbnail does not leak a referrer",
          rich.locator("img.pv-thumb").get_attribute("referrerpolicy") == "no-referrer")

    # ---------- the title is borrowed only when the item has none ----------
    check("an untitled item borrows the page title",
          "flask" in rich.locator(".title a").inner_text().lower())

    add_item(page, "https://example.org", title="My own words")
    page.wait_for_timeout(2500)
    mine = card_for(page, "https://example.org")
    check("a title you typed is never overwritten by the preview",
          mine.locator(".title a").inner_text().strip() == "My own words")

    # ---------- a page with no OG tags degrades quietly ----------
    add_item(page, PLAIN_URL)
    page.wait_for_timeout(2500)
    plain = card_for(page, PLAIN_URL)
    check("a page without og tags still gets its favicon", plain.locator(".fav").count() == 1)
    check("a page without og tags shows no empty preview block",
          plain.locator(".pv-desc").count() == 0 and plain.locator("img.pv-thumb").count() == 0)

    # ---------- an unreachable URL degrades to the plain card ----------
    add_item(page, DEAD_URL)
    page.wait_for_timeout(3000)
    dead = card_for(page, DEAD_URL)
    check("an unfetchable URL still renders a card", dead.count() == 1)
    check("an unfetchable URL shows no broken preview",
          dead.locator("img.pv-thumb").count() == 0 and dead.locator(".fav img").count() == 0)

    # ---------- the review screen shows it too ----------
    # Runs while the Inbox is still short: `#rev-skip` walks the queue in order,
    # and the filler items added below would bury the rich link behind 30 cards.
    page.click("#triage-here")
    page.wait_for_selector("#reviewOverlay.open", timeout=10000)
    seen_preview = False
    for _ in range(6):
        page.wait_for_timeout(1500)
        if page.locator("#rev-card .review-pv img.review-thumb").count() > 0:
            seen_preview = True
            break
        if page.locator("#rev-skip").is_visible():
            page.click("#rev-skip")
    check("the review card shows the preview", seen_preview)
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)

    # ---------- batching + the per-request cap ----------
    before = len(preview_calls)
    page.evaluate(
        """async () => {
             const { upsertItem } = await import('./api-client.js');
             for (let i = 0; i < 30; i++) await upsertItem({ url: `https://sub${i}.invalid/x`, bucket: 'inbox' });
           }"""
    )
    page.click('[data-view="library"]')
    page.click('[data-view="inbox"]')
    page.wait_for_timeout(4000)
    batches = preview_calls[before:]
    check("previews are batched, not one request per card", len(batches) < 30, extra=f"{len(batches)} requests")
    check("no batch exceeds the server's 24-url cap",
          all(len(b) <= 24 for b in batches), extra=str([len(b) for b in batches]))

    # ---------- reload paints from the local cache ----------
    before = len(preview_calls)
    page.reload()
    page.wait_for_selector("#appShell", state="visible", timeout=15000)
    page.click('[data-view="inbox"]')
    page.wait_for_selector(".item", timeout=10000)
    rich = card_for(page, RICH_URL)
    rich.locator(".pv-desc").wait_for(timeout=10000)
    asked_again = [u for batch in preview_calls[before:] for u in batch]
    check("a cached preview survives a reload", rich.locator(".pv-desc").inner_text().strip() != "")
    check("a cached preview is not re-fetched after a reload", RICH_URL not in asked_again)

    real_errors = [e for e in errors if "favicon" not in e.lower() and "ERR_NAME_NOT_RESOLVED" not in e]
    check("no console/page errors", not real_errors, extra=str(real_errors[:3]))

    br.close()

print()
if fails:
    print(f"FAILED ({len(fails)}): " + "; ".join(fails))
    sys.exit(1)
print("ALL PREVIEW CHECKS PASSED")
