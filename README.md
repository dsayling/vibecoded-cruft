# Vibecoded Cruft

A static dashboard measuring how much abandoned, AI-generated code is piling up on GitHub:
commits that admit a robot wrote them, repos that die the day they are born, repos nobody
ever stars.

Two collector scripts write JSON into `site/data/`. The site is plain HTML, CSS and vanilla
JS with hand-rolled SVG charts — no build step, no dependencies, no API calls from the
browser.

## Quick start

```bash
gh auth login                                        # default public scope is enough
uv run scripts/calibrate.py                          # ~10s  repo-ID → date curve
uv run scripts/sample_search.py --n 2500             # ~100m cohort metadata
uv run scripts/sample_repos.py --n 500 --pause 20    # ~15m  AI config detection
uv run scripts/sample_repos.py --aggregate-only      #       build cohorts.json
uv run scripts/ai_markers.py                         # ~25m  commit attribution
python3 -m http.server -d site 8000
```

**Run these one at a time.** GitHub's secondary rate limits are per account, so two
collectors going at once throttle each other.

Useful flags:

```bash
uv run scripts/sample_repos.py --buckets 3 --n 500     # smoke test
uv run scripts/sample_repos.py --aggregate-only        # rebuild JSON from cached raw data
uv run scripts/sample_repos.py --batch 25              # gentler on secondary rate limits
uv run scripts/ai_markers.py --months 2024-06,2025-06  # spot check
```

### Resuming a partial run

Expect to be throttled. `sample_repos.py` writes each quarter to `data/raw/<bucket>.jsonl`
as it finishes, so stopping mid-run costs nothing:

```bash
uv run scripts/sample_repos.py --aggregate-only   # publish what you already have
uv run scripts/sample_repos.py --n 10000          # later: picks up where it left off
```

Re-running skips quarters that already hold enough rows and, for partial quarters, skips
repos already on disk instead of paying to look them up twice. Duplicates are collapsed at
aggregation time, so an interrupted run can never double-count. `ai_markers.py` caches every
search result in `data/raw/markers_cache.json` and re-queries only the current month and
year, which are the two that go stale.

If a run is throttled hard, stop and come back later rather than pushing through — the
hourly budget is usually still untouched, so waiting for *it* does not help, and continuing
to hammer extends the secondary penalty.

## Why not GH Archive

The obvious source for this is [GH Archive](https://www.gharchive.org/), and it does not
work for this question any more. Probing `data.gharchive.org` directly shows three eras:

| Period | State |
|---|---|
| 2011 → 2025-10 | Full payloads: commit messages, PR `merged` flag, PR author |
| 2025-11 → 2026-03 | Payloads stripped — no commit messages, no PR author |
| 2026-04 → today | Feed collapsed: PR/Watch/IssueComment events down ~95%, files ~98% `PushEvent` |

The stripping cutover bisects to between 2025-10-01 and 2025-11-01. Separately, the public
`githubarchive` BigQuery dataset has not been updated since roughly 2022, so it cannot see
the AI era at all — and scanning it costs $6.25/TB.

The live GitHub API answers this question better, is current, and is free.

## Method

### Commit attribution — `scripts/ai_markers.py`

One `search/commits` query per tool per month, using **exact trailer phrases only**
(`"Generated with Claude Code"`, `"Co-authored-by: Copilot"`, …). Bare tool names are
unusable: grepping GH Archive commit messages for `codex` produced a 69-per-10k spike in
Aug 2024 that was almost entirely the ordinary English word, and `cursor` matches the text
caret.

Search is the scarcest budget, so the script queries each year first and only expands the
months of years that returned a non-zero count.

### Repository cohorts — `scripts/sample_search.py` (primary)

The repository search API returns full metadata — `created_at`, `pushed_at`, stars, forks,
`archived`, `size`, `language` — 100 repos per request. That is far cheaper than
enumerating IDs and enriching them one batch at a time.

**The trap: never take a ranked prefix.** Search defaults to best-match ordering, so page 1
of a wide query is the *most relevant* repos rather than a sample of them. Measured on
2026Q2, that approach reports **20% zero-star where the true value is ~95%** — an error
that flatters the data in exactly the direction this project is trying to measure.

So instead of sampling a ranked list, the collector takes a **census of a narrow creation
window**: pick a time slice whose entire population fits under search's 1000-result cap,
then page through all of it. A census of a random window is an honest cluster sample.
Window width self-tunes per quarter, because public repo creation grew roughly tenfold
across the covered years — five minutes suits 2026 and is nearly empty in 2020.

Validated against the independent ID-probe sampler on 2026Q2: DOA 68.2% vs 64.9%,
zero-star 94.4% vs ~96%. Two unrelated methods agreeing is the main evidence that either
is sound.

Search cannot see file listings, so rows from this collector carry `ai: null` and AI
detection comes from the GraphQL pass below.

### Repository cohorts — `scripts/sample_repos.py` (ID probes + AI detection)

`GET /repositories?since={id}` enumerates public repos by ID, 100 per page, and IDs are
assigned in creation order — so an ID range is a date range. `calibrate.py` samples anchor
IDs across the whole space, resolves their `createdAt`, and inverts the curve into quarterly
bucket boundaries.

Within each quarter, probe points are spread evenly across the ID range and a page of 100
repos is taken at each. Walking sequentially from the start of a quarter would sample its
first few minutes instead of the whole thing.

Enrichment goes through GraphQL, aliasing 100 repos into one query — **1 rate-limit point
per 100 repos**. AI tooling is detected by fetching each repo's root tree
(`object(expression: "HEAD:")`) and matching filenames, rather than probing for each known
path. One lookup instead of four is dramatically cheaper server-side, and it means a newly
released tool can be detected by re-reading `data/raw/` instead of re-querying GitHub.

Repos are filed under their real `createdAt`, not the bucket that found them, so calibration
error affects only sample spread and never which quarter a repo counts in.

### Rate limits

The hourly budget (5,000 REST + 5,000 GraphQL points) is not the binding constraint —
GitHub's *secondary* limits are, and they trigger on request rate and server CPU time. A
batched repository query gets throttled long before the point budget runs out.

`scripts/lib.py` handles this with a global pace limiter per surface (REST, GraphQL, search)
that widens automatically when a secondary limit is hit. Three things learned the hard way:

- **Do not run both collectors at once.** Secondary limits are per account, so they
  throttle each other.
- **Widening must be rate-limited itself.** Every request in flight when a limit trips
  comes back throttled, so a naive widen-per-403 compounds — five concurrent failures once
  took the interval from 1.2s to the ceiling in four seconds. `Pace.slow_down()` therefore
  steps at most once per 30 seconds.
- **Secondary limits arrive two ways.** Sometimes as a message in the body, sometimes as a
  bare `Retry-After` header. Detect them as "a 403 that is not the primary limit" rather
  than by matching the body text, or the `Retry-After` variety silently skips the backoff.

**The decisive finding: batched GraphQL could not be made to work at volume.** Every
variation was throttled within a minute or two of sustained collection — 100-alias and
25-alias batches, with and without the expensive tree lookups, paced from 0.5s out to 4s,
after cooldowns of 7 and 15 minutes. The penalty has a memory measured in hours, not
minutes: the only clean GraphQL run of a session was the first one after an overnight rest.

That is why cohort metadata moved to `sample_search.py`. The search API carries a
different limiter and has not throttled once. GraphQL is now used only for AI config
detection, in bursts small enough to stay under the limit.

Sustainable settings: 4s between searches, and for the GraphQL pass keep each quarter to
roughly 20 requests with `--pause` between quarters.

## Reading the numbers

- **Attribution measures disclosure, not use.** Every AI figure is a lower bound.
- **Committer dates are self-reported.** Rebases, imports and history rewrites put a
  handful of commits in years before the tool that "wrote" them existed — `"Generated with
  Claude Code"` returns exactly 1 hit for both 2022 and 2023. Years under `NOISE_FLOOR`
  (12 hits) are treated as zero and not expanded into months; the raw year totals are kept
  in `markers.json` under `year_totals` so the decision is auditable.
- **Search `total_count` is an estimate, with more spread than that implies.** One identical
  query (`"Co-Authored-By: Claude"`, calendar 2022) returned 1,180 and later 95 on the same
  day. Treat the commit chart as orders of magnitude, not measurements.
- **Use the broad trailer for every tool.** Tools change their commit-message format and a
  narrow query silently stops matching, which looks exactly like a collapse in usage:

  | query | Apr 2026 |
  |---|---|
  | `"Generated with Claude Code"` | 87,421 |
  | `"Co-Authored-By: Claude"` | 11,193,470 |
  | `"Co-authored-by: Cursor Agent"` | 15,779 (Jun) |
  | `"Co-authored-by: Cursor"` | 1,301,810 (Jun) |

  The broad form admits a floor of a few thousand hits a year from humans named Claude,
  Cursor or Devin. That floor is disclosed in `year_totals`; a missing order of magnitude
  would not be.
- **"Dead on arrival" undercounts**: `pushedAt` moves for some non-commit events.
- **Forks are excluded** from all cohort metrics.
- **Age-gated metrics are omitted, not zeroed.** A quarter younger than 90 days has no
  90-day death rate; the site leaves those points out rather than plotting a fake 0%.
- **Repos under `MIN_AGE_DAYS` (30) are excluded entirely.** A repo created last week has
  not had a chance to be revisited, so counting it as abandoned manufactures a spike in
  the newest cohort. Measured on 2026Q3: 68.0% dead on arrival unfiltered against 60.3%
  with the floor — the difference between "abandonment is spiking" and "abandonment is
  flat".
- **AI config detection reads `HEAD`, i.e. the repo as it is today.** A repo abandoned
  after one push can never come back to add a `CLAUDE.md`; a repo under active development
  can. So "carries AI instructions" is partly a proxy for "still alive", and the
  `ai_vs_rest` comparison is contaminated by that circularity. The scan finds these files
  in ~0.35% of repos created in 2022 — years before any of them existed — which measures
  the effect directly. Treat that comparison as suggestive at best. Settling it properly
  needs the file's presence *in the first commit*, which requires walking commit history.
- **Only fixed-window metrics compare across cohorts.** Dead-on-arrival and the 30/90-day
  death rates ask the same question of every quarter. Star counts and lifespans accumulate
  for as long as a repo has existed, so a 2020 cohort has had six years to gather stars
  against weeks for the newest one. Those two series describe present state per quarter and
  must not be read as trends.
- Proportions carry 95% Wilson intervals — Wilson rather than normal because several of
  these sit above 90%, where a normal interval runs past 100%.
- **Abandonment is not failure.** A scratch repo that did its job in an afternoon looks
  identical to garbage from here. The trend across quarters is the interesting part.

## Layout

```
scripts/lib.py            shared client: token, pacing, backoff, GraphQL batching, Wilson CI
scripts/calibrate.py      repo-ID → date curve      → data/id_calendar.json
scripts/ai_markers.py     commit + code search      → site/data/markers.json
scripts/sample_repos.py   cohort sampling           → site/data/cohorts.json
site/                     the dashboard (static, deploys to GitHub Pages as-is)
data/raw/                 gitignored intermediates, enable resume
```
