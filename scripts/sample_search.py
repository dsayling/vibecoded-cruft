"""Sample repository cohorts by taking a census of short creation-time windows.

The repository search API returns full metadata — created_at, pushed_at, stars, forks,
archived, size, language — 100 repos per request, which makes it far cheaper than
enumerating IDs and enriching them through GraphQL.

The catch is ranking. Search defaults to best-match, so page 1 of a wide query is the
*most relevant* repos, not a sample of them: asking for a day of 2026Q2 that way reports
20% zero-star against a true value near 95%. Using it safely means never taking a ranked
prefix. Instead we pick a window narrow enough that its entire population fits under
search's 1000-result cap, then page through all of it. A census of a random window is an
honest cluster sample; a ranked top-N is not.

Validated against the independent ID-probe sampler on 2026Q2 — DOA 68.2% vs 64.9%,
zero-star 94.4% vs ~96%.

    uv run scripts/sample_search.py --n 10000
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import ROOT, GitHub, append_raw, get_token, load_raw, log  # noqa: E402

PER_PAGE = 100
MAX_RESULTS = 1000  # hard cap the search API imposes on any single query
SAFE_TOTAL = 900  # shrink the window if a census would bump into that cap


def iso(when: dt.datetime) -> str:
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def to_row(item: dict) -> dict:
    """Match the shape written by sample_repos.py so both feed one aggregator."""
    return {
        "nameWithOwner": item.get("full_name"),
        "createdAt": item.get("created_at"),
        "pushedAt": item.get("pushed_at"),
        # Every metric here compares a stored timestamp against a clock. Without knowing
        # *when* the row was read, `pushedAt` silently ages: a repo captured three days
        # after creation still passes a 30-day age gate months later, on three-day-old
        # evidence, which is exactly what that gate exists to prevent.
        "observed_at": iso(dt.datetime.now(dt.timezone.utc)),
        "stargazerCount": item.get("stargazers_count", 0),
        "forkCount": item.get("forks_count", 0),
        "isArchived": bool(item.get("archived")),
        "isFork": bool(item.get("fork")),
        # Search exposes no "empty" flag, and `size` is rounded to KB — a repo holding a
        # 300-byte README reports 0 and is not empty. Deriving isEmpty from it would feed
        # the aggregator two different definitions of the same field depending on which
        # collector reached the quarter first. None means "not measured".
        "isEmpty": None,
        "diskUsage": item.get("size") or 0,
        "lang": item.get("language"),
        # Search cannot see file listings, so AI config detection needs the separate
        # GraphQL trees pass. None means "not checked", never "checked, found nothing".
        "ai": None,
    }


async def census(gh: GitHub, start: dt.datetime, minutes: int) -> tuple[list[dict], bool]:
    """Page through every repo created in one window. Returns (rows, was_truncated)."""
    end = start + dt.timedelta(minutes=minutes) - dt.timedelta(seconds=1)
    q = f"created:{iso(start)}..{iso(end)} fork:false"

    first = await gh.search("repositories", q, per_page=PER_PAGE, sort="created", order="asc")
    if not first:
        return [], False
    total = first.get("total_count", 0)
    if total > SAFE_TOTAL:
        # Too busy a window to enumerate honestly — the caller retries it narrower
        # rather than accepting a ranked prefix.
        return [], True

    items = first.get("items", [])
    pages = min(-(-total // PER_PAGE), MAX_RESULTS // PER_PAGE)
    for page in range(2, pages + 1):
        nxt = await gh.search(
            "repositories", q, per_page=PER_PAGE, page=page, sort="created", order="asc"
        )
        got = (nxt or {}).get("items", [])
        items += got
        if len(got) < PER_PAGE:
            break
    return [to_row(i) for i in items], False


async def collect_quarter(gh: GitHub, bucket: dict, target: int) -> int:
    name = bucket["bucket"]
    existing = load_raw(name)
    if len(existing) >= target:
        log(f"{name}: {len(existing)} rows cached, skipping")
        return len(existing)

    have = {r.get("nameWithOwner") for r in existing}
    start = dt.datetime.fromisoformat(bucket["start_date"]).replace(tzinfo=dt.timezone.utc)
    end = dt.datetime.fromisoformat(bucket["end_date"]).replace(tzinfo=dt.timezone.utc)
    span = (end - start).total_seconds()

    collected = len(existing)
    attempts = 0
    # Public repo creation grew roughly tenfold over the covered years, so no fixed
    # window suits every quarter: five minutes is right for 2026 and nearly empty in
    # 2020. Carry the working size forward and let it converge per era instead of
    # rediscovering it — and probing for it — on every window.
    minutes = 15
    while collected < target and attempts < 300:
        # Golden-ratio offsets spread windows across the quarter without clustering,
        # and shift on resumed runs so we land on fresh ground.
        frac = ((attempts * 0.6180339887) + len(existing) / max(target, 1)) % 1.0
        origin = start + dt.timedelta(seconds=frac * span)
        origin = origin.replace(second=0, microsecond=0)

        rows, truncated = await census(gh, origin, minutes)
        while truncated and minutes > 1:
            minutes = max(1, minutes // 2)
            rows, truncated = await census(gh, origin, minutes)
        attempts += 1
        # A sparse window wastes a request on pagination overhead; widen for the next
        # one. Capped so a quiet era cannot walk the window out to days.
        if not truncated and len(rows) < SAFE_TOTAL // 3 and minutes < 240:
            minutes *= 2
        if not rows:
            continue

        fresh = [r for r in rows if r["nameWithOwner"] not in have]
        have.update(r["nameWithOwner"] for r in fresh)
        if fresh:
            append_raw(name, fresh)
            collected += len(fresh)

    log(f"{name}: {collected} rows after {attempts} windows")
    return collected


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10_000, help="repos per quarter")
    ap.add_argument("--buckets", type=int, default=0, help="limit to the newest N quarters")
    args = ap.parse_args()

    calendar = ROOT / "data" / "id_calendar.json"
    if not calendar.exists():
        sys.exit("Missing data/id_calendar.json — run scripts/calibrate.py first.")
    buckets = json.loads(calendar.read_text())["buckets"]
    if args.buckets:
        buckets = buckets[-args.buckets :]

    gh = GitHub(get_token(), concurrency=1)
    try:
        for b in buckets:
            await collect_quarter(gh, b, args.n)
    finally:
        await gh.close()
    log("done — run `sample_repos.py --aggregate-only` to rebuild site/data/cohorts.json")


if __name__ == "__main__":
    asyncio.run(main())
