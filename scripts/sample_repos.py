"""Sample public repositories per quarterly cohort and measure how they died.

Sampling is stratified inside each quarter: we spread probe IDs evenly across the
quarter's ID range and take a page of 100 repos at each probe. Walking sequentially
from the start of a quarter would instead sample the first few minutes of it.

Cohort assignment uses each repo's real `createdAt`, not the bucket we probed, so
calibration error only affects sample spread and never which quarter a repo counts in.

    uv run scripts/sample_repos.py                 # full run
    uv run scripts/sample_repos.py --buckets 2 --n 500   # smoke test
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import (  # noqa: E402
    AI_CONFIG_KEYS,
    ROOT,
    SITE_DATA,
    GitHub,
    append_raw,
    detect_ai_tools,
    enrich,
    get_token,
    load_raw,
    log,
    median,
    percentile,
    wilson,
    write_json,
)

PAGE = 100
NOW = dt.datetime.now(dt.timezone.utc)

# How many of the newest quarters feed the by-language breakdown. Language is a present-
# state attribute like stars, so pooling twenty quarters of it would mostly describe how
# GitHub's language mix has drifted since 2020.
LANG_QUARTERS = 4
LANG_MIN_N = 50

# Every repo gets this long to show a second sign of life before it counts as dead.
# Without it the newest cohort is scored on repos that are only days old and have not
# had the chance to be revisited, which inflates "dead on arrival" and depresses stars.
# Measured on 2026Q3: 68.0% unfiltered against 60.3% at a 30-day floor — the difference
# between "abandonment is spiking" and "abandonment is flat".
MIN_AGE_DAYS = 30


def parse_ts(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def as_of(row: dict) -> dt.datetime:
    """When this row's `pushedAt` was actually true.

    Raw rows are cached indefinitely and reused across runs, so comparing a frozen
    `pushedAt` against a live clock quietly breaks every age-gated metric. Rows written
    before `observed_at` existed fall back to now, which is the old (wrong) behaviour —
    but only for them, and `stale_days` on the cohort makes it visible.
    """
    return parse_ts(row.get("observed_at")) or NOW


def quarter_of(when: dt.datetime) -> str:
    return f"{when.year}Q{(when.month - 1) // 3 + 1}"


def quarter_end(bucket: str) -> dt.datetime:
    year, q = int(bucket[:4]), int(bucket[-1])
    return (
        dt.datetime(year + 1, 1, 1, tzinfo=dt.timezone.utc)
        if q == 4
        else dt.datetime(year, 3 * q + 1, 1, tzinfo=dt.timezone.utc)
    )


def compact(row: dict, trees: bool) -> dict:
    """Reduce a GraphQL row to what the aggregation needs.

    The root tree can carry hundreds of filenames per repo; keeping them all would
    make the raw files an order of magnitude larger for no analytical gain.

    `ai` is None when trees were not fetched, which is different from [] meaning
    "checked, found nothing". Conflating them would silently understate AI adoption
    by counting unchecked repos as clean.
    """
    return {
        "nameWithOwner": row.get("nameWithOwner"),
        "createdAt": row.get("createdAt"),
        "pushedAt": row.get("pushedAt"),
        # See as_of(): without this the 30-day age gate is defeated by its own cache.
        "observed_at": NOW.isoformat(),
        "stargazerCount": row.get("stargazerCount", 0),
        "forkCount": row.get("forkCount", 0),
        "isArchived": bool(row.get("isArchived")),
        "isFork": bool(row.get("isFork")),
        "isEmpty": bool(row.get("isEmpty")),
        "diskUsage": row.get("diskUsage") or 0,
        "lang": (row.get("primaryLanguage") or {}).get("name"),
        "ai": detect_ai_tools(row) if trees else None,
    }


async def collect_bucket(
    gh: GitHub, bucket: dict, target: int, batch: int, trees: bool, refresh_stale: int = 0
) -> tuple[int, int]:
    """Fetch and enrich `target` repos spread across one quarter. Returns (kept, missing)."""
    name = bucket["bucket"]
    existing = load_raw(name)

    def fresh(r: dict) -> bool:
        """Is this row recent enough to trust without re-reading it?"""
        if not refresh_stale:
            return True
        return (NOW - as_of(r)).days < refresh_stale

    if refresh_stale:
        stale_rows = sum(1 for r in existing if not fresh(r))
        if stale_rows:
            log(f"{name}: {stale_rows} rows older than {refresh_stale}d, re-reading")
    # In a trees pass, rows collected by an earlier metadata-only pass do not count
    # toward the target — they have no AI data to contribute.
    have = sum(
        1 for r in existing if fresh(r) and (r.get("ai") is not None if trees else True)
    )
    if have >= target:
        log(f"{name}: {have} rows cached, skipping")
        return have, 0

    probes = max(1, target // PAGE)
    span = bucket["end_id"] - bucket["start_id"]
    step = max(1, span // probes)
    probe_ids = [bucket["start_id"] + i * step for i in range(probes)]

    async def page(pid: int) -> list[str]:
        got = await gh.rest("/repositories", since=pid, per_page=PAGE)
        return [r["full_name"] for r in got] if got else []

    pages = await asyncio.gather(*(page(p) for p in probe_ids), return_exceptions=True)
    names: list[str] = []
    for p in pages:
        if isinstance(p, list):
            names.extend(p)
    names = list(dict.fromkeys(names))  # probe ranges can overlap where IDs are sparse

    # A resumed run re-probes the bucket from the start, so drop anything already on
    # disk rather than paying to look it up twice. In a trees pass, a repo seen only
    # by the metadata pass is still worth fetching — it has no AI data yet.
    if existing:
        done = {
            r.get("nameWithOwner")
            for r in existing
            if fresh(r) and (r.get("ai") is not None if trees else True)
        }
        names = [n for n in names if n not in done]
        if not names:
            log(f"{name}: {len(existing)} rows cached, nothing new")
            return have, 0

    rows = await enrich(gh, names, batch=batch, trees=trees)
    missing = len(names) - len(rows)
    append_raw(name, [compact(r, trees) for r in rows])
    log(f"{name}: {len(rows)} repos ({missing} vanished between listing and lookup)")
    return len(rows), missing


def summarise(rows: list[dict], bucket: str) -> dict | None:
    """Aggregate one cohort. Age-gated metrics are omitted, never reported as zero."""
    candidates = [r for r in rows if not r.get("isFork") and r.get("createdAt")]
    live = []
    for r in candidates:
        created = parse_ts(r.get("createdAt"))
        # Gate on how old the repo was *when we looked*, not on how old it is now.
        # Using NOW here lets a row captured days after creation clear a 30-day floor
        # months later, which reinstates precisely the bias the floor was added to remove.
        if created and (as_of(r) - created).days >= MIN_AGE_DAYS:
            live.append(r)
    n = len(live)
    if n < 30:
        return None

    ended = quarter_end(bucket)
    age_days = (NOW - ended).days

    lifespans: list[float] = []
    doa = d30 = d90 = alive90 = zero_star = zero_fork = archived = 0
    empty = empty_checked = 0
    ai_any = ai_checked = 0
    ai_by_tool = dict.fromkeys(AI_CONFIG_KEYS, 0)

    for r in live:
        created, pushed = parse_ts(r.get("createdAt")), parse_ts(r.get("pushedAt"))
        if r.get("stargazerCount", 0) == 0:
            zero_star += 1
        if r.get("forkCount", 0) == 0:
            zero_fork += 1
        if r.get("isArchived"):
            archived += 1
        # Only GraphQL rows carry a real "no commits" flag; search rows say None.
        # Counting those as not-empty would understate it by the search sample's size.
        if r.get("isEmpty") is not None:
            empty_checked += 1
            if r["isEmpty"]:
                empty += 1
        if r.get("ai") is not None:
            ai_checked += 1
            hits = r["ai"]
            if hits:
                ai_any += 1
                for k in hits:
                    if k in ai_by_tool:
                        ai_by_tool[k] += 1
        if not (created and pushed):
            continue
        days = (pushed - created).total_seconds() / 86400
        lifespans.append(max(0.0, days))
        if pushed.date() == created.date():
            doa += 1
        if days <= 30:
            d30 += 1
        if days <= 90:
            d90 += 1
        else:
            alive90 += 1

    stale = [round((NOW - as_of(r)).total_seconds() / 86400, 1) for r in live]
    out = {
        "bucket": bucket,
        "n": n,
        "excluded_too_young": len(candidates) - n,
        # The median is pinned inside day one for every quarter — more than half of each
        # cohort dies on the day it is born, so it reports the floor and nothing else.
        # The upper percentiles sit above that mass and are the ones worth plotting.
        "median_lifespan_days": round(median(lifespans), 2),
        "lifespan_p75_days": round(percentile(lifespans, 0.75), 2),
        "lifespan_p90_days": round(percentile(lifespans, 0.90), 2),
        "median_disk_kb": round(median([r.get("diskUsage") or 0 for r in live]), 1),
        "dead_on_arrival": wilson(doa, n),
        "zero_stars": wilson(zero_star, n),
        "zero_forks": wilson(zero_fork, n),
        "archived": wilson(archived, n),
        # How old the underlying observations are. Everything above compares a stored
        # timestamp against a clock, so this is the honest expiry date on the row.
        "stale_days_median": round(median(stale), 1),
        "stale_days_max": round(max(stale), 1) if stale else 0.0,
    }
    if empty_checked >= 30:
        out["empty"] = wilson(empty, empty_checked)
        out["empty_checked"] = empty_checked

    # AI detection runs on its own smaller pass, so its denominator is the number of
    # repos actually checked, not the whole cohort.
    if ai_checked >= 30:
        out["ai_checked"] = ai_checked
        out["ai_config"] = wilson(ai_any, ai_checked)
        out["ai_by_tool"] = {k: wilson(v, ai_checked) for k, v in ai_by_tool.items()}
        # Raw counts matter as much as the rates here. At a ~0.3% true rate and ~250
        # repos per quarter, a single repo moves the line between 0% and 0.4%, which
        # reads as a tool appearing and vanishing. The site needs the counts to know
        # which points are too thin to plot.
        out["ai_any_count"] = ai_any
        out["ai_counts"] = dict(ai_by_tool)

    # A cohort cannot show 30-day death until every repo in it has had 30 days to die.
    # Reporting these unconditionally is how you get a fake 0% on the newest quarter.
    if age_days >= 30:
        out["dead_within_30d"] = wilson(d30, n)
    if age_days >= 90:
        out["dead_within_90d"] = wilson(d90, n)
        out["fate"] = {
            "dead_on_arrival": round(100 * doa / n, 2),
            "died_within_30d": round(100 * (d30 - doa) / n, 2),
            "died_within_90d": round(100 * (d90 - d30) / n, 2),
            "lived_past_90d": round(100 * alive90 / n, 2),
        }
    return out


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=10_000, help="repos per quarter")
    ap.add_argument("--buckets", type=int, default=0, help="limit to the newest N quarters")
    ap.add_argument("--aggregate-only", action="store_true", help="re-aggregate cached raw data")
    ap.add_argument(
        "--pause",
        type=float,
        default=20.0,
        help="seconds to idle between quarters, to keep bursts from accumulating",
    )
    ap.add_argument(
        "--no-trees",
        action="store_true",
        help="skip AI config-file detection. Much cheaper server-side, so this is the "
        "mode that survives a long run; do a second smaller pass without it for AI data.",
    )
    ap.add_argument(
        "--refresh-stale",
        type=int,
        default=0,
        metavar="DAYS",
        help="re-read rows observed more than DAYS ago instead of trusting the cache. "
        "Every metric here compares a stored pushedAt against a clock, so cached rows "
        "decay: repos revived since collection stay counted as dead. 0 disables.",
    )
    ap.add_argument(
        "--batch",
        type=int,
        default=50,
        help="repos per GraphQL query. Larger is cheaper against the hourly point budget "
        "but more likely to trip secondary rate limits, which is the real constraint.",
    )
    args = ap.parse_args()

    calendar_path = ROOT / "data" / "id_calendar.json"
    if not calendar_path.exists():
        sys.exit("Missing data/id_calendar.json — run scripts/calibrate.py first.")
    all_buckets = json.loads(calendar_path.read_text())["buckets"]
    # `--buckets` narrows what we *collect*; aggregation always reads every bucket on
    # disk. Otherwise a partial resume republishes a partial cohorts.json and throws
    # away quarters that were already collected.
    buckets = all_buckets[-args.buckets :] if args.buckets else all_buckets

    total_missing = 0
    if not args.aggregate_only:
        gh = GitHub(get_token(), concurrency=3)
        try:
            before = await gh.rate_limits()
            log(
                f"budget: core {before.get('core', {}).get('remaining')}, "
                f"graphql {before.get('graphql', {}).get('remaining')}"
            )
            for i, b in enumerate(buckets):
                _, missing = await collect_bucket(
                    gh, b, args.n, args.batch,
                    trees=not args.no_trees,
                    refresh_stale=args.refresh_stale,
                )
                total_missing += missing
                # Secondary limits key on sustained bursts, not on the hourly budget:
                # a 20-request bucket runs clean where a 100-request one throttles
                # within a minute. Idling between buckets lets the limiter's window
                # slide instead of accumulating pressure across the whole run.
                if args.pause and i < len(buckets) - 1:
                    await asyncio.sleep(args.pause)
            after = await gh.rate_limits()
            log(
                f"spent: core {before.get('core', {}).get('remaining', 0) - after.get('core', {}).get('remaining', 0)}, "
                f"graphql {before.get('graphql', {}).get('remaining', 0) - after.get('graphql', {}).get('remaining', 0)}"
            )
        finally:
            await gh.close()

    # Repos are re-bucketed by their true createdAt, so a repo probed under one
    # quarter still lands in the quarter it was actually born in.
    # Interrupted runs append, adjacent probes overlap, and a trees pass revisits repos
    # the metadata pass already saw — so the raw files legitimately contain duplicates.
    # Keep one row per repo, preferring whichever version carries AI data.
    # Merge rather than pick: take the freshest observation for the perishable fields and
    # carry `ai` across from whichever row has it. Preferring the AI-carrying row outright
    # would keep its stale `pushedAt` too, aging the metric that matters most.
    best: dict[str, dict] = {}
    for b in all_buckets:
        for row in load_raw(b["bucket"]):
            key = row.get("nameWithOwner")
            if not key:
                continue
            prior = best.get(key)
            if prior is None:
                best[key] = row
                continue
            newer, older = (
                (row, prior)
                if (row.get("observed_at") or "") > (prior.get("observed_at") or "")
                else (prior, row)
            )
            merged = dict(newer)
            if merged.get("ai") is None and older.get("ai") is not None:
                merged["ai"] = older["ai"]
            if merged.get("isEmpty") is None and older.get("isEmpty") is not None:
                merged["isEmpty"] = older["isEmpty"]
            best[key] = merged

    by_quarter: dict[str, list[dict]] = defaultdict(list)
    for row in best.values():
        created = parse_ts(row.get("createdAt"))
        if created:
            by_quarter[quarter_of(created)].append(row)

    cohorts = [c for q in sorted(by_quarter) if (c := summarise(by_quarter[q], q))]

    # Do repos carrying AI instructions get abandoned at a different rate than the rest?
    # Both groups are drawn from the same quarters and measured over the same fixed
    # one-day window, so this comparison is immune to the exposure-time confound that
    # makes the star and lifespan series uncomparable across cohorts. Per-quarter the
    # AI group is too small to say anything, so it is pooled.
    # Crucially this must be computed *within* quarters. AI config files barely exist
    # before 2024, so a naive pool puts almost every AI repo in recent quarters and
    # compares them against a control group dominated by 2020 — which measures the
    # difference between years, not between groups.
    def eligible(r: dict) -> bool:
        if r.get("isFork") or r.get("ai") is None or not r.get("pushedAt"):
            return False
        created = parse_ts(r.get("createdAt"))
        return bool(created and (as_of(r) - created).days >= MIN_AGE_DAYS)

    def is_dead(r: dict) -> bool:
        return r["createdAt"][:10] == r["pushedAt"][:10]

    ai_n = ai_dead = rest_n = rest_dead = 0
    per_quarter = []
    for q in sorted(by_quarter):
        rows = [r for r in by_quarter[q] if eligible(r)]
        with_ai = [r for r in rows if r["ai"]]
        without = [r for r in rows if not r["ai"]]
        # Only quarters holding a usable number of both contribute, so every repo
        # counted is matched against controls born in the same three months.
        if len(with_ai) < 10 or len(without) < 10:
            continue
        ai_n += len(with_ai)
        ai_dead += sum(1 for r in with_ai if is_dead(r))
        rest_n += len(without)
        rest_dead += sum(1 for r in without if is_dead(r))
        per_quarter.append(
            {
                "bucket": q,
                "with_ai_config": wilson(sum(1 for r in with_ai if is_dead(r)), len(with_ai)),
                "without": wilson(sum(1 for r in without if is_dead(r)), len(without)),
                "n_ai": len(with_ai),
                "n_rest": len(without),
            }
        )

    comparison = {
        "method": "within-quarter; only quarters with >=10 repos in both groups",
        "quarters_used": [p["bucket"] for p in per_quarter],
        "with_ai_config": (
            {"n": ai_n, "dead_on_arrival": wilson(ai_dead, ai_n)} if ai_n >= 30 else None
        ),
        "without": (
            {"n": rest_n, "dead_on_arrival": wilson(rest_dead, rest_n)} if rest_n >= 30 else None
        ),
        "per_quarter": per_quarter,
    }
    # Both collectors have always recorded `lang` and the aggregator has always thrown it
    # away. Dead-on-arrival is a fixed-window metric, so splitting it by language is a
    # fair comparison and costs nothing — the rows are already on disk.
    lang_quarters = sorted(by_quarter)[-LANG_QUARTERS:]
    by_lang: dict[str, list[dict]] = defaultdict(list)
    for q in lang_quarters:
        for r in by_quarter[q]:
            created = parse_ts(r.get("createdAt"))
            if r.get("isFork") or not r.get("pushedAt") or not created:
                continue
            if (as_of(r) - created).days < MIN_AGE_DAYS:
                continue
            by_lang[r.get("lang") or "(none detected)"].append(r)

    lang_total = sum(len(v) for v in by_lang.values())
    lang_rows = []
    for name, group in sorted(by_lang.items(), key=lambda kv: -len(kv[1])):
        if len(group) < LANG_MIN_N:
            continue
        dead = sum(1 for r in group if is_dead(r))
        lang_rows.append(
            {
                "lang": name,
                "n": len(group),
                "share": round(100 * len(group) / lang_total, 2) if lang_total else 0.0,
                "dead_on_arrival": wilson(dead, len(group)),
                "zero_stars": wilson(
                    sum(1 for r in group if r.get("stargazerCount", 0) == 0), len(group)
                ),
            }
        )

    stale_all = [round((NOW - as_of(r)).total_seconds() / 86400, 1) for r in best.values()]
    write_json(
        SITE_DATA / "cohorts.json",
        {
            "generated_at": NOW.isoformat(),
            "sampled_per_quarter": args.n,
            "total_repos": sum(c["n"] for c in cohorts),
            "vanished_between_calls": total_missing,
            "min_age_days": MIN_AGE_DAYS,
            # generated_at says when the JSON was written, which is not when the repos
            # were looked at. On a resumed collection those can be months apart.
            "observation_age_days": {
                "median": round(median(stale_all), 1),
                "max": round(max(stale_all), 1) if stale_all else 0.0,
                "rows_without_observed_at": sum(
                    1 for r in best.values() if not r.get("observed_at")
                ),
            },
            "languages": {
                "quarters_used": lang_quarters,
                "min_n": LANG_MIN_N,
                "n_total": lang_total,
                "rows": lang_rows,
            },
            "ai_vs_rest": comparison,
            "cohorts": cohorts,
        },
    )
    for c in cohorts[-5:]:
        doa = c["dead_on_arrival"]
        log(f"  {c['bucket']}: n={c['n']:>6} DOA {doa[0]:.1f}% [{doa[1]:.1f}–{doa[2]:.1f}]")


if __name__ == "__main__":
    asyncio.run(main())
