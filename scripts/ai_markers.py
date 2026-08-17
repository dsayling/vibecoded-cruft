"""Count commits that admit an AI wrote them, by month.

Only high-precision trailer strings are used. Bare tool names are unusable: grepping
GH Archive commit messages for the word "codex" reported a 69-per-10k spike in Aug
2024 that was almost entirely ordinary English, and "cursor" matches the text caret.
Every pattern here is an exact phrase that only a tool emits.

    uv run scripts/ai_markers.py                          # full history
    uv run scripts/ai_markers.py --months 2024-06,2025-06 # spot check
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import RAW_DIR, SITE_DATA, GitHub, get_token, log, median, write_json  # noqa: E402

START = (2022, 1)

# label -> exact phrase searched in commit messages
# Prefer the loose co-author trailer for every tool, and accept the small name-collision
# floor that comes with it.
#
# The tempting alternative — a more specific phrase — fails badly, because tools change
# their trailer format and a narrow query silently stops matching. Both attempts at this
# were catastrophic:
#
#   "Generated with Claude Code"    Apr 2026:     87,421   <- looks like a collapse
#   "Co-Authored-By: Claude"        Apr 2026: 11,193,470   <- what actually happened
#
#   "Co-authored-by: Cursor Agent"  Jun 2026:     15,779   <- trailer predates "Agent"
#   "Co-authored-by: Cursor"        Jun 2026:  1,301,810
#
# The false-positive floors these avoid are ~1,000-4,000 hits/year from humans named
# Claude, Cursor or Devin. The false negatives they cause are millions per month. Floors
# that small are visible in `year_totals` and disclosed on the page; a missing order of
# magnitude is not recoverable.
MARKERS = {
    "Claude": '"Co-Authored-By: Claude"',
    "GitHub Copilot": '"Co-authored-by: Copilot"',
    "Cursor": '"Co-authored-by: Cursor"',
    "Devin": '"Co-authored-by: Devin"',
    "aider": '"Co-authored-by: aider"',
    "OpenAI Codex": '"Co-authored-by: openai-codex"',
}

# label -> repo-root file that marks a repo as AI-instructed
CONFIG_FILES = {
    "CLAUDE.md": "filename:CLAUDE.md path:/",
    "AGENTS.md": "filename:AGENTS.md path:/",
    ".cursorrules": "filename:.cursorrules path:/",
    ".windsurfrules": "filename:.windsurfrules path:/",
    "copilot-instructions.md": "filename:copilot-instructions.md path:.github",
    # Path-scoped Copilot instructions: any number of *.instructions.md files under
    # .github/instructions/, each applying to a glob via frontmatter. Filenames vary
    # per repo, so this counts the directory rather than one exact name.
    ".github/instructions/*.md": "path:.github/instructions extension:md",
}

# label -> last month whose hits provably cannot come from the tool, inclusive.
#
# The broad co-author trailers above buy completeness at the price of a name-collision
# floor: real humans are called Claude, Cursor and Devin. That floor is not small and
# it is not hypothetical — measured over the months below, Devin runs a median of 378
# hits/month and Claude 109, every one of them years before the tool shipped. Left
# uncorrected the site draws them as adoption on a chart headed "commits that admit a
# robot wrote them".
#
# The floor is measurable precisely because these months exist: whatever the query
# returns before a tool was released is, by construction, entirely false positives.
# So take the median over that window and subtract it from every month.
#
# Dates are the first plausible month for the *trailer*, not for the product, and err
# late — an over-long baseline only makes the correction more conservative.
BASELINE_UNTIL = {
    "Claude": "2025-01",          # Claude Code research preview, Feb 2025
    "GitHub Copilot": "2023-12",  # the Copilot co-author trailer arrives with the agent
    "Cursor": "2024-12",          # editor shipped 2023; the agent trailer is a 2025 thing
    "Devin": "2024-12",           # announced Mar 2024, generally available Dec 2024
    "aider": "2023-05",           # aider's first release is mid-2023
    "OpenAI Codex": "2025-04",    # Codex agent, May 2025
}

CACHE = RAW_DIR / "markers_cache.json"

# A year must clear this many hits before its months are worth querying individually.
# Roughly one per month; below that the year is backdated noise, not adoption.
#
# Note this floor does NOT remove the collision problem and never could: it is annual
# and absolute, so Devin's 4,140 collisions in 2022 clear it 345x over. Its only job is
# saving twelve searches on a year that is genuinely empty. The subtraction above is
# what actually corrects the numbers.
NOISE_FLOOR = 12


def next_month(month: str) -> str:
    y, m = int(month[:4]), int(month[5:])
    return f"{y + 1}-01" if m == 12 else f"{y}-{m + 1:02d}"


def collision_floors(series: dict, months: list[str]) -> dict:
    """Median monthly hit count over each tool's pre-release window."""
    out = {}
    for label, until in BASELINE_UNTIL.items():
        vals = [v for m, v in zip(months, series.get(label) or []) if m <= until and v is not None]
        # Too short a baseline is worse than none: one unlucky month would be subtracted
        # from every real month in the series.
        if len(vals) < 6:
            out[label] = None
            continue
        out[label] = {
            "per_month": round(median(vals), 1),
            "baseline_months": len(vals),
            "baseline_until": until,
            "max_seen": max(vals),
        }
    return out


def apply_floors(series: dict, floors: dict) -> dict:
    """Subtract each tool's collision floor, clamped at zero. None stays None."""
    out = {}
    for label, vals in series.items():
        f = (floors.get(label) or {}).get("per_month", 0.0)
        out[label] = [None if v is None else max(0, int(round(v - f))) for v in vals]
    return out


def derive(payload: dict) -> dict:
    """Recompute every field derived from the raw monthly counts.

    Split out so it can be re-run over an already-published markers.json without
    spending a single search request (`--rebuild`).
    """
    months, series = payload["months"], payload["series"]
    floors = collision_floors(series, months)
    adjusted = apply_floors(series, floors)
    year_totals = payload.get("year_totals") or {}

    # The same commits counted twelve months at a time versus one year at a time should
    # agree and do not: measured here, monthly sums come to 2.5x the annual ones, and
    # 86% of that gap is the single largest series. Whatever GitHub does to estimate
    # total_count degrades as the result set grows, so the biggest number on the page is
    # the least trustworthy one. Publish both and let the site show the range rather than
    # picking the flattering end.
    annual = 0
    for label, per_year in year_totals.items():
        until = BASELINE_UNTIL.get(label)
        first = int(next_month(until)[:4]) if until else 0
        for year, value in per_year.items():
            if value and int(year) >= first:
                annual += value

    payload["collision_floors"] = floors
    payload["series_adjusted"] = adjusted
    payload["total_attributed_commits"] = sum(v for vals in adjusted.values() for v in vals if v)
    payload["total_attributed_commits_raw"] = sum(v for vals in series.values() for v in vals if v)
    payload["total_attributed_commits_annual"] = annual
    return payload


def months_until(end: dt.date) -> list[str]:
    out, (y, m) = [], START
    while (y, m) <= (end.year, end.month):
        out.append(f"{y}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def month_range(month: str) -> str:
    y, m = int(month[:4]), int(month[5:])
    first = dt.date(y, m, 1)
    last = (dt.date(y + 1, 1, 1) if m == 12 else dt.date(y, m + 1, 1)) - dt.timedelta(days=1)
    return f"{first.isoformat()}..{last.isoformat()}"


def year_range(year: int) -> str:
    return f"{year}-01-01..{year}-12-31"


def load_cache() -> dict:
    if CACHE.exists():
        try:
            return json.loads(CACHE.read_text())
        except json.JSONDecodeError:
            pass
    return {}


def save_cache(cache: dict) -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache))


def write_markers(cache: dict, months: list[str], current: str, configs: dict, partial: bool) -> None:
    """Emit markers.json from whatever counts are known.

    A month absent from the cache is reported as None rather than 0 so the site can break
    the line there. Under heavy throttling a full run takes hours, and a gap that is
    plotted as zero reads as "adoption collapsed" rather than "not measured yet".
    """
    series = {label: [cache.get(f"{label}|{m}") for m in months] for label in MARKERS}
    measured = sum(1 for vals in series.values() for v in vals if v is not None)

    # Where a cell was sampled more than once, publish the observed spread. A single
    # search is not a measurement: the same query has returned 1,180 and 95 on the same
    # day, and the Cursor series swings 12,805 -> 993,219 -> 766,480 month to month.
    spread = {
        label: [
            (lambda s: [min(s), max(s)] if s and len(s) > 1 else None)(
                cache.get(f"{label}|{m}~s")
            )
            for m in months
        ]
        for label in MARKERS
    }

    # Self-check: the same commits counted twelve months at a time versus one year at a
    # time should agree. They do for small markers and diverge badly for large ones
    # (aider 1.00x, Claude 2.97x), which says GitHub's total_count degrades as the result
    # set grows. Published so a reader can see how much to trust each number.
    years = sorted({int(m[:4]) for m in months})
    consistency = {}
    for label in MARKERS:
        month_sum = sum(v for v in series[label] if v)
        year_sum = sum(v for v in (cache.get(f"{label}|{y}") for y in years) if v)
        consistency[label] = {
            "month_sum": month_sum,
            "year_sum": year_sum,
            "ratio": round(month_sum / year_sum, 2) if year_sum else None,
        }
    payload = derive(
        {
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "months": months,
            "queries": MARKERS,
            "config_queries": CONFIG_FILES,
            "series": series,
            "series_spread": spread,
            # Code search counts *files*, not repos, and a repo commonly carries several
            # (in the cohort sample, 33 AI repos account for 50 CLAUDE.md + AGENTS.md
            # hits). Summing these is therefore not a repo count and the site must not
            # present it as one.
            "config_files": configs,
            "config_files_counts": "files matching, not repos; repos commonly match several",
            "partial_month": current if current in months else None,
            "incomplete": partial or measured < len(months) * len(MARKERS),
            "measured_points": measured,
            "total_points": len(months) * len(MARKERS),
            "noise_floor": NOISE_FLOOR,
            "self_consistency": consistency,
            "year_totals": {
                label: {str(y): cache.get(f"{label}|{y}") for y in sorted({int(m[:4]) for m in months})}
                for label in MARKERS
            },
        },
    )
    write_json(SITE_DATA / "markers.json", payload)

    log(f"AI-attributed commits since {months[0]}: "
        f"{payload['total_attributed_commits_annual']:,} (annual queries) – "
        f"{payload['total_attributed_commits']:,} (monthly, collision-adjusted) "
        f"({measured}/{len(months) * len(MARKERS)} points measured)")
    adj = payload["series_adjusted"]
    for label, vals in sorted(adj.items(), key=lambda kv: -sum(v for v in kv[1] if v)):
        floor = (payload["collision_floors"].get(label) or {}).get("per_month")
        raw = sum(v for v in series[label] if v)
        log(f"  {label:<20} {sum(v for v in vals if v):>12,} "
            f"(raw {raw:>12,}, collision floor {floor if floor is not None else '?'}/mo)")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--months", help="comma-separated YYYY-MM, default is full history")
    ap.add_argument("--refresh", action="store_true", help="ignore cached counts")
    ap.add_argument(
        "--from-cache",
        action="store_true",
        help="write markers.json from cached results without querying. Search throttling "
        "can stretch a full run over hours, and a half-finished run should still publish.",
    )
    ap.add_argument(
        "--rebuild",
        action="store_true",
        help="recompute the derived fields of an existing site/data/markers.json in place "
        "(collision floors, adjusted series, headline totals). No API calls.",
    )
    ap.add_argument(
        "--repeat",
        type=int,
        default=1,
        help="samples per (tool, month). GitHub's total_count is an estimate that varies "
        "run to run, so one search is not a measurement; 3 gives a median and a spread. "
        "Costs one full extra pass per extra sample, so pair it with --months.",
    )
    args = ap.parse_args()

    if args.rebuild:
        path = SITE_DATA / "markers.json"
        if not path.exists():
            sys.exit(f"Missing {path} — nothing to rebuild.")
        write_json(path, derive(json.loads(path.read_text())))
        return

    today = dt.datetime.now(dt.timezone.utc).date()
    months = args.months.split(",") if args.months else months_until(today)
    cache = {} if args.refresh else load_cache()

    current = f"{today.year}-{today.month:02d}"
    if not args.from_cache:
        # The current month and year are still accumulating, so cached counts for them go
        # stale daily. Drop them before probing so this run re-measures both.
        for label in MARKERS:
            cache.pop(f"{label}|{current}", None)
            cache.pop(f"{label}|{today.year}", None)

    if args.from_cache:
        # The code-search totals are not part of the month cache, so carry them over from
        # a previous run rather than dropping them when republishing.
        prior = SITE_DATA / "markers.json"
        configs = {}
        if prior.exists():
            try:
                configs = json.loads(prior.read_text()).get("config_files") or {}
            except json.JSONDecodeError:
                pass
        write_markers(cache, months, current, configs, partial=False)
        return

    gh = GitHub(get_token(), concurrency=4)
    try:

        def samples_for(key: str) -> list[int]:
            """Every observation of one cell. Older caches hold a bare int; adopt it."""
            got = cache.get(f"{key}~s")
            if got is None:
                return [cache[key]] if key in cache else []
            return got

        def needs(key: str, repeat: int) -> bool:
            return len(samples_for(key)) < repeat

        async def count(key: str, query: str, repeat: int = 1) -> int:
            samples = samples_for(key)
            while len(samples) < repeat:
                res = await gh.search("commits", query)
                samples.append((res or {}).get("total_count", 0))
                cache[f"{key}~s"] = samples
                # The published value is the median of the samples, not the last one —
                # a single draw from an estimator this noisy is not worth publishing.
                cache[key] = int(median(samples))
                # Persist immediately. Search throttling can stall a run for minutes at a
                # time, and a stall that gets killed must not throw away completed work.
                save_cache(cache)
            return cache[key]

        # Search is the scarcest budget here, so skip months that cannot contain a
        # hit: ask for the year first, and only expand a year that returned results.
        # Claude Code alone has three empty years, which is 36 requests saved.
        todo: list[tuple[str, str]] = []
        if args.months:
            todo = [(label, m) for label in MARKERS for m in months]
        else:
            years = sorted({int(m[:4]) for m in months})
            probes = [(label, y) for label in MARKERS for y in years]
            todo_probes = [p for p in probes if f"{p[0]}|{p[1]}" not in cache]
            log(f"probing {len(MARKERS)} markers across {len(years)} years "
                f"({len(todo_probes)}/{len(probes)} still to do)")
            for label in MARKERS:
                for year in years:
                    total = await count(f"{label}|{year}", f"{MARKERS[label]} committer-date:{year_range(year)}")
                    # Committer dates are self-reported and rewritable, so tools show a
                    # handful of "commits" in years before they existed — Claude Code
                    # returns exactly 1 for both 2022 and 2023. Expanding such a year
                    # spends twelve throttled searches to plot a flat zero.
                    if total >= NOISE_FLOOR:
                        todo += [(label, m) for m in months if m.startswith(str(year))]
                    else:
                        for m in months:
                            if m.startswith(str(year)):
                                cache[f"{label}|{m}"] = 0
            save_cache(cache)

        todo = [(label, m) for label, m in todo if needs(f"{label}|{m}", args.repeat)]
        if todo:
            searches = sum(args.repeat - len(samples_for(f"{l}|{m}")) for l, m in todo)
            log(f"{len(todo)} month cells, {searches} searches "
                f"(~{searches * gh.search_min_interval / 60:.0f} min)")
        for done, (label, month) in enumerate(todo, 1):
            await count(
                f"{label}|{month}",
                f"{MARKERS[label]} committer-date:{month_range(month)}",
                repeat=args.repeat,
            )
            if done % 25 == 0:
                save_cache(cache)
                log(f"  {done}/{len(todo)} cells")
        save_cache(cache)

        log("counting AI config files (files matched, not repos)")
        configs = {}
        for label, q in CONFIG_FILES.items():
            res = await gh.search("code", q)
            configs[label] = (res or {}).get("total_count", 0)
            log(f"  {label}: {configs[label]:,}")

        write_markers(cache, months, current, configs, partial=False)
    finally:
        await gh.close()


if __name__ == "__main__":
    asyncio.run(main())
