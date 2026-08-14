"""Build the repository-ID to calendar-date curve.

GitHub assigns repository IDs sequentially at creation, so an ID range is a time
range. `GET /repositories?since=` enumerates by ID but returns minimal repo objects
with no `created_at`, so the dates have to come from GraphQL.

We sample anchor IDs across the whole space, resolve their creation dates, and invert
the resulting curve into quarterly bucket boundaries the sampler can walk.

    uv run scripts/calibrate.py
"""

from __future__ import annotations

import argparse
import asyncio
import bisect
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import ROOT, GitHub, enrich, get_token, log, write_json  # noqa: E402

# Below this, repos predate the window we care about (roughly 2019).
FLOOR_ID = 150_000_000
FIRST_QUARTER = (2020, 1)


async def find_max_id(gh: GitHub) -> int:
    """Exponentially probe upward, then binary search for the highest live ID."""
    lo, hi = 1_000_000_000, 2_000_000_000
    while await gh.rest("/repositories", since=hi, per_page=1):
        lo, hi = hi, hi * 2
    while hi - lo > 1_000_000:
        mid = (lo + hi) // 2
        if await gh.rest("/repositories", since=mid, per_page=1):
            lo = mid
        else:
            hi = mid
    log(f"highest live repo id ~{lo:,}")
    return lo


async def anchor_names(gh: GitHub, ids: list[int]) -> dict[int, str]:
    """One repo name at or just past each anchor ID."""

    async def one(i: int):
        page = await gh.rest("/repositories", since=i, per_page=1)
        if page:
            return i, page[0]["full_name"], page[0]["id"]
        return i, None, None

    out = {}
    for chunk_start in range(0, len(ids), 50):
        chunk = ids[chunk_start : chunk_start + 50]
        for anchor, name, real_id in await asyncio.gather(*(one(i) for i in chunk)):
            if name:
                out[real_id] = name
    return out


async def build_curve(gh: GitHub, anchors: int, max_id: int) -> list[dict]:
    step = (max_id - FLOOR_ID) // anchors
    ids = list(range(FLOOR_ID, max_id, step))
    log(f"resolving {len(ids)} anchors between {FLOOR_ID:,} and {max_id:,}")

    id_to_name = await anchor_names(gh, ids)
    names = list(id_to_name.values())
    rows = await enrich(gh, names)
    by_name = {r["nameWithOwner"]: r for r in rows if r.get("nameWithOwner")}

    curve = []
    for repo_id, name in id_to_name.items():
        row = by_name.get(name)
        if row and row.get("createdAt"):
            curve.append({"id": repo_id, "created": row["createdAt"]})
    curve.sort(key=lambda c: c["id"])

    # IDs are assigned at creation, so the curve should already be monotonic. Clamp
    # anyway: a single out-of-order anchor would otherwise corrupt every bucket
    # boundary derived from it.
    peak = ""
    cleaned = []
    for point in curve:
        if point["created"] < peak:
            continue
        peak = point["created"]
        cleaned.append(point)
    dropped = len(curve) - len(cleaned)
    if dropped:
        log(f"dropped {dropped} non-monotonic anchor(s)")
    return cleaned


def quarters_until(end: dt.date) -> list[tuple[int, int]]:
    out, (y, q) = [], FIRST_QUARTER
    while (y, q) <= (end.year, (end.month - 1) // 3 + 1):
        out.append((y, q))
        y, q = (y + 1, 1) if q == 4 else (y, q + 1)
    return out


def quarter_start(y: int, q: int) -> dt.datetime:
    return dt.datetime(y, 3 * (q - 1) + 1, 1, tzinfo=dt.timezone.utc)


def id_at(curve: list[dict], when: dt.datetime, max_id: int) -> int:
    """Linearly interpolate the repo ID in use at a given instant."""
    times = [dt.datetime.fromisoformat(c["created"].replace("Z", "+00:00")) for c in curve]
    idx = bisect.bisect_left(times, when)
    if idx == 0:
        return curve[0]["id"]
    if idx >= len(curve):
        return max_id
    t0, t1 = times[idx - 1], times[idx]
    i0, i1 = curve[idx - 1]["id"], curve[idx]["id"]
    span = (t1 - t0).total_seconds()
    frac = 0.0 if span <= 0 else (when - t0).total_seconds() / span
    return int(i0 + frac * (i1 - i0))


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--anchors", type=int, default=240)
    args = ap.parse_args()

    gh = GitHub(get_token(), concurrency=10)
    try:
        max_id = await find_max_id(gh)
        curve = await build_curve(gh, args.anchors, max_id)
        if len(curve) < 20:
            sys.exit(f"only resolved {len(curve)} anchors; refusing to build buckets")

        today = dt.datetime.now(dt.timezone.utc).date()
        buckets = []
        for y, q in quarters_until(today):
            start = quarter_start(y, q)
            end = quarter_start(y + 1, 1) if q == 4 else quarter_start(y, q + 1)
            sid, eid = id_at(curve, start, max_id), id_at(curve, end, max_id)
            if eid <= sid:
                continue
            buckets.append(
                {
                    "bucket": f"{y}Q{q}",
                    "start_date": start.date().isoformat(),
                    "end_date": end.date().isoformat(),
                    "start_id": sid,
                    "end_id": eid,
                    "id_span": eid - sid,
                }
            )

        write_json(
            ROOT / "data" / "id_calendar.json",
            {
                "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                "max_id": max_id,
                "curve": curve,
                "buckets": buckets,
            },
        )
        log(f"{len(buckets)} quarterly buckets, {curve[0]['created'][:7]} → {curve[-1]['created'][:7]}")
        for b in buckets[-4:]:
            log(f"  {b['bucket']}: ids {b['start_id']:,}–{b['end_id']:,} ({b['id_span']:,} repos)")
    finally:
        await gh.close()


if __name__ == "__main__":
    asyncio.run(main())
