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

from lib import RAW_DIR, SITE_DATA, GitHub, get_token, log, write_json  # noqa: E402

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
    "copilot-instructions.md": "filename:copilot-instructions.md path:.github",
}

CACHE = RAW_DIR / "markers_cache.json"

# A year must clear this many hits before its months are worth querying individually.
# Roughly one per month; below that the year is backdated noise, not adoption.
NOISE_FLOOR = 12


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
    total = sum(v for vals in series.values() for v in vals if v)

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
    write_json(
        SITE_DATA / "markers.json",
        {
            "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "months": months,
            "queries": MARKERS,
            "config_queries": CONFIG_FILES,
            "series": series,
            "config_files": configs,
            "total_attributed_commits": total,
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
    log(f"total AI-attributed commits since {months[0]}: {total:,} "
        f"({measured}/{len(months) * len(MARKERS)} points measured)")
    for label, vals in sorted(series.items(), key=lambda kv: -sum(v for v in kv[1] if v)):
        got = sum(v for v in vals if v)
        log(f"  {label:<20} {got:>12,}")


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
    args = ap.parse_args()

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

        async def count(key: str, query: str) -> int:
            if key in cache:
                return cache[key]
            res = await gh.search("commits", query)
            cache[key] = (res or {}).get("total_count", 0)
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

        todo = [(label, m) for label, m in todo if f"{label}|{m}" not in cache]
        if todo:
            log(f"{len(todo)} month searches (~{len(todo) * gh.search_min_interval / 60:.0f} min)")
        for done, (label, month) in enumerate(todo, 1):
            await count(f"{label}|{month}", f"{MARKERS[label]} committer-date:{month_range(month)}")
            if done % 25 == 0:
                save_cache(cache)
                log(f"  {done}/{len(todo)} searches")
        save_cache(cache)

        log("counting repos by AI config file")
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
