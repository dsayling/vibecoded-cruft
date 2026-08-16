"""Shared GitHub API plumbing for the collectors.

Everything here is async httpx against api.github.com. We deliberately do not shell
out to `gh` per request: the collectors make thousands of calls and subprocess spawn
overhead alone pushed a prototype past a two-minute timeout.
"""

from __future__ import annotations

import asyncio
import json
import math
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"
SITE_DATA = ROOT / "site" / "data"

API = "https://api.github.com"


def get_token() -> str:
    """Token from the environment, else from the authenticated gh CLI."""
    for var in ("GITHUB_TOKEN", "GH_TOKEN"):
        if os.environ.get(var):
            return os.environ[var]
    try:
        out = subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True, timeout=15
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        pass
    sys.exit(
        "No GitHub token. Set GITHUB_TOKEN or run `gh auth login`.\n"
        "The collectors are read-only; a token with default public scope is enough."
    )


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


class Pace:
    """Global minimum interval between requests, independent of concurrency.

    GitHub's secondary rate limits are driven by request rate and server CPU time,
    not by the hourly point budget, so staying under the documented 5000/hour is not
    enough on its own. This spaces requests out while still allowing several to be
    in flight at once.
    """

    def __init__(self, interval: float):
        self.floor = interval
        self.interval = interval
        self._lock = asyncio.Lock()
        self._next = 0.0
        self._last_widened = 0.0

    async def wait(self) -> None:
        async with self._lock:
            now = time.monotonic()
            start = max(now, self._next)
            self._next = start + self.interval
        delay = start - time.monotonic()
        if delay > 0:
            await asyncio.sleep(delay)

    def slow_down(self, factor: float = 1.6, ceiling: float = 4.0) -> bool:
        """Widen the interval, at most once per cooldown. Returns whether it moved.

        Requests already in flight when a limit trips all come back throttled, so a
        naive widen-per-403 compounds: five concurrent failures turned a 1.2s interval
        into the 5s ceiling in four seconds. One episode should cost one step.
        """
        now = time.monotonic()
        if now - self._last_widened < 30:
            return False
        self._last_widened = now
        self.interval = min(self.interval * factor, ceiling)
        return True

    def speed_up(self, factor: float = 0.93, quiet_for: float = 90.0) -> None:
        """Ease back toward the starting interval after a sustained quiet stretch.

        Throttling is often a temporary penalty rather than a permanent verdict, so an
        interval that only ever grows leaves the collector crawling long after GitHub
        has forgiven it. Recovery is deliberately slower than backoff.
        """
        if self.interval <= self.floor:
            return
        if time.monotonic() - self._last_widened < quiet_for:
            return
        self.interval = max(self.floor, self.interval * factor)


class GitHub:
    """Async client with rate-limit handling for REST, GraphQL and search.

    The three surfaces have independent budgets: REST core and GraphQL each get
    5000/hour, while search is capped at roughly 30 requests/minute. Search calls
    therefore go through a separate serialized lane with a minimum interval.
    """

    def __init__(self, token: str, concurrency: int = 10):
        self.client = httpx.AsyncClient(
            base_url=API,
            timeout=httpx.Timeout(30.0),
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "vibecodedcruft-collector",
            },
            limits=httpx.Limits(max_connections=concurrency + 5),
        )
        self.sem = asyncio.Semaphore(concurrency)
        self.rest_pace = Pace(0.2)
        # Batched repository queries are server-expensive enough that GitHub throttles
        # on them long before the hourly point budget runs out. Start deliberately slow
        # and let the adaptive backoff tune upward from here.
        self.gql_pace = Pace(1.8)
        self.search_lock = asyncio.Lock()
        # Search advertises 30 req/min, but commit search trips an undocumented
        # secondary limit well below that. Start conservative and let _request back
        # this off further whenever GitHub complains.
        self.search_min_interval = 4.0
        self._last_search = 0.0

    async def close(self) -> None:
        await self.client.aclose()

    async def _request(self, method: str, url: str, *, tries: int = 8, is_search: bool = False, **kw):
        """One request with backoff for rate limits, abuse detection and 5xx."""
        for attempt in range(tries):
            try:
                r = await self.client.request(method, url, **kw)
            except (httpx.TransportError, httpx.TimeoutException) as e:
                if attempt == tries - 1:
                    raise
                await asyncio.sleep(2**attempt)
                continue

            if r.status_code < 400:
                if not is_search:
                    (self.gql_pace if url == "/graphql" else self.rest_pace).speed_up()
                return r

            if r.status_code in (403, 429):
                retry_after = r.headers.get("retry-after")
                remaining = r.headers.get("x-ratelimit-remaining")
                primary = remaining == "0"

                if primary:
                    # Nothing to do but wait for the hourly window to reset.
                    reset = float(r.headers.get("x-ratelimit-reset", 0))
                    wait = max(0.0, min(reset - time.time() + 2, 3700))
                elif retry_after:
                    wait = min(float(retry_after), 300)
                else:
                    wait = 60 * (attempt + 1)

                # Anything that is not the primary limit is a secondary one, and
                # secondary limits recur: resuming at the old pace just trips them
                # again. Slow down for the rest of the run, not only for this retry.
                # GitHub signals these either in the body or with Retry-After, so key
                # off "not primary" rather than sniffing the message text.
                if not primary:
                    if is_search:
                        self.search_min_interval = min(self.search_min_interval * 1.5, 30.0)
                        log(f"search pace now {self.search_min_interval:.1f}s")
                    else:
                        pace = self.gql_pace if url == "/graphql" else self.rest_pace
                        if pace.slow_down():
                            log(f"{'graphql' if url == '/graphql' else 'rest'} pace now {pace.interval:.2f}s")

                if attempt == tries - 1:
                    r.raise_for_status()
                log(f"rate limited ({r.status_code}), sleeping {wait:.0f}s")
                await asyncio.sleep(wait)
                continue

            if r.status_code >= 500:
                if attempt == tries - 1:
                    r.raise_for_status()
                await asyncio.sleep(2**attempt)
                continue

            return r  # 4xx we care about (404 etc.) — let the caller decide
        raise RuntimeError("unreachable")

    async def rest(self, path: str, **params):
        async with self.sem:
            await self.rest_pace.wait()
            r = await self._request("GET", path, params=params or None)
        if r.status_code >= 400:
            return None
        return r.json()

    async def graphql(self, query: str) -> dict:
        """Return the `data` block.

        GitHub answers partial successes with HTTP 200, a populated `data` and a
        non-empty `errors` array — typically NOT_FOUND for repos renamed or deleted
        between enumeration and enrichment. Roughly 7% of a fresh sample. Those are
        real signal, so we keep the data and let the caller count the gaps.
        """
        async with self.sem:
            await self.gql_pace.wait()
            r = await self._request("POST", "/graphql", json={"query": query})
        try:
            body = r.json()
        except ValueError:
            return {}
        return body.get("data") or {}

    async def search(self, kind: str, q: str, **params) -> dict | None:
        """Serialized search request. `kind` is 'commits', 'code' or 'repositories'."""
        async with self.search_lock:
            gap = time.monotonic() - self._last_search
            if gap < self.search_min_interval:
                await asyncio.sleep(self.search_min_interval - gap)
            r = await self._request(
                "GET",
                f"/search/{kind}",
                params={"q": q, "per_page": 1, **params},
                is_search=True,
            )
            self._last_search = time.monotonic()
        if r.status_code >= 400:
            return None
        return r.json()

    async def rate_limits(self) -> dict:
        data = await self.rest("/rate_limit")
        return (data or {}).get("resources", {})


# --- GraphQL repo enrichment -------------------------------------------------

# One tree lookup returns every filename at the repo root, which is both cheaper than
# probing for four specific paths and more informative — new AI tools can be detected
# by re-reading cached data instead of re-querying GitHub. Server cost matters here:
# four per-path lookups per repo tripped secondary rate limits within seconds.
REPO_FIELDS_BASE = """
    createdAt pushedAt stargazerCount forkCount isArchived isFork isEmpty diskUsage
    primaryLanguage { name }
"""

# The tree lookups are what make a batched query expensive: they walk git objects
# rather than reading indexed scalars. Sustained batches carrying them get flagged as
# scraping within a minute or two no matter how slowly they are paced, so they are
# opt-in and run as a separate, smaller pass.
REPO_FIELDS_TREES = """
    root:      object(expression:"HEAD:")        { ... on Tree { entries { name } } }
    dotgithub: object(expression:"HEAD:.github") { ... on Tree { entries { name } } }
"""

# tool -> filenames that mark a repo as instructed by it
ROOT_MARKERS = {
    "claude": {"CLAUDE.md", ".claude"},
    "agents": {"AGENTS.md"},
    "cursor": {".cursorrules", ".cursor"},
    "gemini": {"GEMINI.md"},
    "windsurf": {".windsurfrules"},
    "cline": {".clinerules"},
    "aider": {".aider.conf.yml", ".aider.conf.yaml"},
}
DOTGITHUB_MARKERS = {"copilot": {"copilot-instructions.md"}}

AI_CONFIG_KEYS = tuple(ROOT_MARKERS) + tuple(DOTGITHUB_MARKERS)


def detect_ai_tools(row: dict) -> list[str]:
    """Which AI tools left a config file in this repo."""
    def names(key: str) -> set[str]:
        node = row.get(key) or {}
        return {e["name"] for e in (node.get("entries") or [])}

    root, dotgithub = names("root"), names("dotgithub")
    found = [t for t, marks in ROOT_MARKERS.items() if marks & root]
    found += [t for t, marks in DOTGITHUB_MARKERS.items() if marks & dotgithub]
    return found


def build_repo_query(full_names: list[str], trees: bool = True) -> str:
    """Alias up to ~100 repositories into a single query. Costs 1 rate-limit point."""
    fields = REPO_FIELDS_BASE + (REPO_FIELDS_TREES if trees else "")
    parts = []
    for i, full in enumerate(full_names):
        owner, _, name = full.partition("/")
        if not owner or not name:
            continue
        parts.append(
            f"  n{i}: repository(owner:{json.dumps(owner)}, name:{json.dumps(name)})"
            f" {{ nameWithOwner {fields} }}"
        )
    return "query{\n" + "\n".join(parts) + "\n}"


async def enrich(
    gh: GitHub, full_names: list[str], batch: int = 100, trees: bool = True
) -> list[dict]:
    """Resolve repo metadata for a list of `owner/name` strings."""
    chunks = [full_names[i : i + batch] for i in range(0, len(full_names), batch)]
    results = await asyncio.gather(
        *(gh.graphql(build_repo_query(c, trees)) for c in chunks), return_exceptions=True
    )
    rows: list[dict] = []
    for res in results:
        if isinstance(res, BaseException) or not res:
            continue
        rows.extend(v for k, v in res.items() if k.startswith("n") and v)
    return rows


# --- stats -------------------------------------------------------------------


def wilson(successes: int, n: int, z: float = 1.96) -> tuple[float, float, float]:
    """Point estimate and Wilson score interval, all as percentages.

    Wilson rather than normal approximation because several of these proportions sit
    near 0 or 1 (zero-star share runs above 90%), where the normal interval produces
    bounds outside [0, 1].
    """
    if n == 0:
        return (0.0, 0.0, 0.0)
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (
        round(100 * p, 2),
        round(100 * max(0.0, centre - margin), 2),
        round(100 * min(1.0, centre + margin), 2),
    )


def median(values: list[float]) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    mid = len(s) // 2
    return float(s[mid]) if len(s) % 2 else (s[mid - 1] + s[mid]) / 2


def percentile(values: list[float], q: float) -> float:
    """Linear-interpolated percentile, q in [0, 1].

    The median of a lifespan distribution is useless here: more than half of every
    cohort dies on day one, so the median is pinned inside the first 24 hours for all
    27 quarters and measures the floor rather than the cohort. Upper percentiles sit
    above the dead-on-arrival mass and actually move.
    """
    if not values:
        return 0.0
    s = sorted(values)
    if len(s) == 1:
        return float(s[0])
    pos = q * (len(s) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return float(s[lo] + (s[hi] - s[lo]) * (pos - lo))


# --- resumable jsonl ---------------------------------------------------------


def raw_path(bucket: str) -> Path:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    return RAW_DIR / f"{bucket}.jsonl"


def load_raw(bucket: str) -> list[dict]:
    p = raw_path(bucket)
    if not p.exists():
        return []
    rows = []
    for line in p.read_text().splitlines():
        if line.strip():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # tolerate a torn final line from an interrupted run
    return rows


def append_raw(bucket: str, rows: list[dict]) -> None:
    with raw_path(bucket).open("a") as f:
        for r in rows:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n")
    log(f"wrote {path.relative_to(ROOT)} ({path.stat().st_size / 1024:.0f} KB)")
