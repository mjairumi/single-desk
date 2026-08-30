"""The catalog axis (items.topic), driven in a real browser.

`bucket` says WHEN you deal with a link; `topic` says what it is ABOUT. Topic
is single-valued on purpose — that is the whole reason the Library can group on
it without duplicating an item into every group it half-belongs to.

What this proves:
  * a topic set in the edit modal round-trips and shows on the card;
  * the Library groups by topic, with an explicit Uncatalogued pile;
  * clicking a topic chip filters, from any view;
  * topics survive a bucket move (the two axes are independent);
  * the modal autocompletes from topics already in use, so the vocabulary
    converges instead of sprouting near-duplicates;
  * a topic syncs to a second device like any other field.

    cd backend && source .venv/bin/activate
    uvicorn app.main:app --port 8000     # terminal 1
    python tests/catalog_e2e.py          # terminal 2
"""
import os
import sys
import uuid

from playwright.sync_api import sync_playwright

BASE = os.environ.get("BASE", "http://127.0.0.1:8000")
EMAIL = f"cat+{uuid.uuid4().hex[:8]}@example.com"
PW = "supersecret1"
fails = []


def check(label, cond, extra=""):
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"   {extra}" if extra and not cond else ""))
    if not cond:
        fails.append(label)


def add(page, url, title, bucket="library", topic=None):
    page.click("#addBtn")
    page.wait_for_selector("#editOverlay.open")
    page.wait_for_timeout(120)          # openEdit() focuses #f-url on a timer
    page.fill("#f-url", url)
    page.fill("#f-title", title)
    page.click(f'#f-bucket button[data-b="{bucket}"]')
    if topic is not None:
        page.fill("#f-topic", topic)
    page.click("#saveItem")
    page.wait_for_timeout(500)


with sync_playwright() as p:
    br = p.chromium.launch()
    ctx = br.new_context()
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)

    page.goto(BASE)
    page.wait_for_selector("#authGate", state="visible", timeout=10000)
    page.click("#authTabSignup")
    page.fill("#authEmail", EMAIL)
    page.fill("#authPassword", PW)
    page.click("#authSubmit")
    page.wait_for_selector("#appShell", state="visible", timeout=15000)

    add(page, "https://example.com/pg", "Postgres tuning", topic="Backend")
    add(page, "https://example.com/idx", "Index internals", topic="Backend")
    add(page, "https://example.com/cv", "Resume templates", topic="Job hunt")
    add(page, "https://example.com/misc", "Something unsorted")      # no topic

    page.click('[data-view="library"]')
    page.wait_for_selector(".item", timeout=10000)

    # ---------- the chip ----------
    card = page.locator('.item[data-purl="https://example.com/pg"]')
    check("a topic set in the modal shows as a chip on the card",
          card.locator('.topic[data-topic="Backend"]').count() == 1)

    # ---------- grouping ----------
    heads = page.locator(".group-head h3")
    labels = [heads.nth(i).inner_text().strip() for i in range(heads.count())]
    check("the Library groups by topic", "Backend" in labels and "Job hunt" in labels,
          extra=str(labels))
    check("items with no topic get an explicit Uncatalogued group",
          "Uncatalogued" in labels, extra=str(labels))
    check("Uncatalogued sorts last — it's a to-do, not a shelf",
          labels and labels[-1] == "Uncatalogued", extra=str(labels))
    check("a group counts its own items",
          page.locator(".group-head").first.locator(".n").inner_text().strip() == "2",
          extra=page.locator(".group-head").first.inner_text())

    # ---------- filtering ----------
    page.click('.filter-tags .topic[data-topic="Backend"]')
    page.wait_for_timeout(400)
    check("clicking a topic filters the Library", page.locator(".item").count() == 2,
          extra=f"{page.locator('.item').count()} items")
    check("a filtered view drops the group headings", page.locator(".group-head").count() == 0)
    page.click('.filter-tags .topic[data-topic="__all"]')
    page.wait_for_timeout(400)
    check("All restores every item", page.locator(".item").count() == 4)

    # ---------- the two axes are independent ----------
    page.click('.item[data-purl="https://example.com/cv"] [data-act="archive"]')
    page.wait_for_timeout(600)
    page.click('[data-view="archive"]')
    page.wait_for_selector(".item", timeout=10000)
    check("a topic survives a bucket move",
          page.locator('.item[data-purl="https://example.com/cv"] .topic[data-topic="Job hunt"]').count() == 1)

    # A topic chip elsewhere is a jump into the catalog.
    page.click('.item[data-purl="https://example.com/cv"] .topic')
    page.wait_for_timeout(500)
    check("a topic chip outside the Library jumps into the catalog",
          "Library" in page.inner_text("h2"))

    # ---------- the vocabulary converges ----------
    page.click("#addBtn")
    page.wait_for_selector("#editOverlay.open")
    page.wait_for_timeout(200)
    options = page.locator("#topicList option")
    values = [options.nth(i).get_attribute("value") for i in range(options.count())]
    check("the modal autocompletes from topics already in use",
          "Backend" in values and "Job hunt" in values, extra=str(values))
    page.keyboard.press("Escape")

    # ---------- it syncs ----------
    page.wait_for_timeout(2500)
    p2 = ctx.browser.new_context()
    page2 = p2.new_page()
    page2.goto(BASE)
    page2.wait_for_selector("#authGate", state="visible", timeout=10000)
    page2.fill("#authEmail", EMAIL)
    page2.fill("#authPassword", PW)
    page2.click("#authSubmit")
    page2.wait_for_selector("#appShell", state="visible", timeout=15000)
    page2.click('[data-view="library"]')
    page2.wait_for_selector(".item", timeout=15000)
    page2.wait_for_timeout(1500)
    check("a topic reaches a second device",
          page2.locator('.item[data-purl="https://example.com/pg"] .topic[data-topic="Backend"]').count() == 1)

    real = [e for e in errors if "favicon" not in e.lower() and "ERR_NAME_NOT_RESOLVED" not in e]
    check("no console/page errors", not real, extra=str(real[:3]))
    br.close()

print()
if fails:
    print(f"FAILED ({len(fails)}): " + "; ".join(fails))
    sys.exit(1)
print("ALL CATALOG CHECKS PASSED")
