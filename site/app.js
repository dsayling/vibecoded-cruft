/* Hand-rolled SVG charts. No dependencies, no network calls beyond the local JSON. */

const NS = 'http://www.w3.org/2000/svg';
const PALETTE = ['#ff5c48', '#ffb020', '#4ea3ff', '#35c98a', '#c084fc', '#f472b6', '#7dd3fc'];

const fmt = n => n.toLocaleString('en-US');
const fmtShort = n => {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return String(Math.round(n));
};

const el = (tag, attrs = {}, text) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
};

/** Round a raw axis maximum up to a readable 1/2/5 x 10^n step. */
function niceTicks(max, count = 5) {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return { top, ticks };
}

/**
 * Shared plot frame: axes, gridlines and label thinning.
 * Returns the svg element plus x()/y() scales for the caller to draw into.
 */
function frame(mount, { labels, top, height = 320, yFormat = fmtShort, width = 860 }) {
  // The viewBox is scaled to fit its container, so a chart in a half-width panel needs
  // a narrower viewBox or its 10px labels render at about 4px on screen.
  const W = width;
  const H = height;
  const M = { t: 16, r: 14, b: 34, l: 52 };
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const { ticks } = niceTicks(top);
  const yMax = ticks[ticks.length - 1];

  const x = i => M.l + (labels.length <= 1 ? iw / 2 : (i / (labels.length - 1)) * iw);
  const y = v => M.t + ih - (Math.max(0, v) / yMax) * ih;

  for (const t of ticks) {
    svg.appendChild(el('line', { class: 'grid-line', x1: M.l, x2: W - M.r, y1: y(t), y2: y(t) }));
    svg.appendChild(el('text', { class: 'tick', x: M.l - 8, y: y(t) + 3.5, 'text-anchor': 'end' }, yFormat(t)));
  }
  svg.appendChild(el('line', { class: 'axis-line', x1: M.l, x2: W - M.r, y1: y(0), y2: y(0) }));

  // Thin x labels so they never collide. The last label is always drawn, so it has to
  // be checked against the previous one — otherwise a series whose length is not a
  // multiple of the stride prints the final two on top of each other.
  const approxCharW = 6;
  const slot = iw / Math.max(labels.length - 1, 1);
  const widest = labels.reduce((m, l) => Math.max(m, l.length), 0) * approxCharW;
  const every = Math.max(1, Math.ceil((widest + 12) / Math.max(slot, 1)));
  const shown = [];
  for (let i = 0; i < labels.length; i += every) shown.push(i);
  const last = labels.length - 1;
  if (shown[shown.length - 1] !== last) {
    // Drop the previous tick if the final one would overlap it.
    if (x(last) - x(shown[shown.length - 1]) < widest + 8) shown.pop();
    shown.push(last);
  }
  for (const i of shown) {
    svg.appendChild(el('text', { class: 'tick', x: x(i), y: H - 12, 'text-anchor': 'middle' }, labels[i]));
  }

  mount.replaceChildren(svg);
  return { svg, x, y, W, H, M, iw, ih, yMax };
}

function pathFrom(points) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
}

/** Render an explanatory placeholder instead of an empty or degenerate chart. */
function emptyState(mount, message) {
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = message;
  mount.replaceChildren(p);
}

/** Paired horizontal bars with confidence whiskers, for a two-group comparison. */
function pairedBars(mount, groups, opts = {}) {
  const W = 860, rowH = 76, H = groups.length * rowH + 34;
  const M = { t: 10, r: 90, l: 200 };
  const iw = W - M.l - M.r;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const top = Math.max(...groups.map(g => g.hi), 10);
  const x = v => M.l + (v / top) * iw;

  groups.forEach((g, i) => {
    const y = M.t + i * rowH;
    svg.appendChild(el('text', { class: 'tick', x: M.l - 14, y: y + 26, 'text-anchor': 'end',
      style: 'font-size:14px;fill:var(--ink)' }, g.label));
    svg.appendChild(el('text', { class: 'tick', x: M.l - 14, y: y + 44, 'text-anchor': 'end' },
      `n = ${fmt(g.n)}`));
    svg.appendChild(el('rect', { x: M.l, y: y + 8, width: Math.max(1, x(g.value) - M.l),
      height: 30, fill: g.color, rx: 3 }));
    // Whisker: the interval is the point of showing this at all.
    svg.appendChild(el('line', { x1: x(g.lo), x2: x(g.hi), y1: y + 23, y2: y + 23,
      stroke: 'var(--ink)', 'stroke-width': 1.5, opacity: 0.55 }));
    for (const b of [g.lo, g.hi]) {
      svg.appendChild(el('line', { x1: x(b), x2: x(b), y1: y + 15, y2: y + 31,
        stroke: 'var(--ink)', 'stroke-width': 1.5, opacity: 0.55 }));
    }
    svg.appendChild(el('text', { x: x(g.value) + 12, y: y + 29,
      style: 'font-size:17px;font-weight:700;fill:var(--ink)', class: 'tick' },
      g.value.toFixed(1) + '%'));
  });
  mount.replaceChildren(svg);
}

/**
 * Crosshair + readout on hover. The chart scales its viewBox to the container, so
 * pointer coordinates have to be mapped back through the rendered size rather than
 * read directly.
 */
function attachHover(mount, f, labels, series, { titles = labels, format = fmt } = {}) {
  if (labels.length < 2) return;

  const tip = document.createElement('div');
  tip.className = 'tooltip';
  tip.hidden = true;
  mount.appendChild(tip);

  const guide = el('line', {
    class: 'guide', y1: f.M.t, y2: f.M.t + f.ih, stroke: 'var(--ink-faint)',
    'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0,
  });
  f.svg.appendChild(guide);
  const dots = series.map(s => {
    const c = el('circle', { r: 4, fill: s.color, stroke: 'var(--panel)', 'stroke-width': 2, opacity: 0 });
    f.svg.appendChild(c);
    return c;
  });

  const move = evt => {
    const rect = f.svg.getBoundingClientRect();
    const vx = ((evt.clientX - rect.left) / rect.width) * f.W;
    let i = Math.round(((vx - f.M.l) / f.iw) * (labels.length - 1));
    i = Math.max(0, Math.min(labels.length - 1, i));

    guide.setAttribute('x1', f.x(i));
    guide.setAttribute('x2', f.x(i));
    guide.setAttribute('opacity', 1);

    const rows = [];
    series.forEach((s, k) => {
      const v = s.values[i];
      if (v == null) {
        dots[k].setAttribute('opacity', 0);
        return;
      }
      dots[k].setAttribute('cx', f.x(i));
      dots[k].setAttribute('cy', f.y(v));
      dots[k].setAttribute('opacity', 1);
      rows.push(`<span class="k"><i style="background:${s.color}"></i>${s.label}</span><b>${format(v)}</b>`);
    });

    tip.innerHTML = `<div class="when">${titles[i]}</div>${rows.join('') || '<div class="when">not measured</div>'}`;
    tip.hidden = false;
    // Flip the tooltip to the left of the cursor near the right edge so it never
    // gets clipped by the panel.
    const frac = f.x(i) / f.W;
    tip.style.left = `${frac * 100}%`;
    tip.style.transform = frac > 0.6 ? 'translate(calc(-100% - 14px), 0)' : 'translate(14px, 0)';
  };

  const leave = () => {
    tip.hidden = true;
    guide.setAttribute('opacity', 0);
    dots.forEach(d => d.setAttribute('opacity', 0));
  };

  f.svg.addEventListener('pointermove', move);
  f.svg.addEventListener('pointerdown', move);
  f.svg.addEventListener('pointerleave', leave);
}

/** Multi-series line chart. Each series is { label, values, color }. */
function lineChart(mount, labels, series, opts = {}) {
  // Confidence bands can reach above the highest plotted point, so they have to be
  // part of the axis maximum or the shading clips at the top of the frame.
  const top = Math.max(
    ...series.flatMap(s => s.values.filter(v => v != null)),
    ...series.flatMap(s => (s.band || []).map(b => b[1])),
    0,
  );
  const f = frame(mount, { labels, top, ...opts });

  for (const s of series) {
    // A null means "not measurable yet", which must break the line rather than
    // plot as a zero.
    let run = [];
    const flush = () => {
      if (run.length > 1) f.svg.appendChild(el('path', { d: pathFrom(run), fill: 'none', stroke: s.color, 'stroke-width': 2.2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      else if (run.length === 1) f.svg.appendChild(el('circle', { cx: run[0][0], cy: run[0][1], r: 2.6, fill: s.color }));
      run = [];
    };

    if (s.band) {
      const upper = [], lower = [];
      s.values.forEach((v, i) => {
        if (v == null) return;
        upper.push([f.x(i), f.y(s.band[i][1])]);
        lower.push([f.x(i), f.y(s.band[i][0])]);
      });
      if (upper.length > 1) {
        f.svg.appendChild(el('path', {
          d: pathFrom(upper) + ' ' + pathFrom(lower.reverse()).replace('M', 'L') + ' Z',
          fill: s.color, opacity: 0.16, stroke: 'none',
        }));
      }
    }

    s.values.forEach((v, i) => {
      if (v == null) flush();
      else run.push([f.x(i), f.y(v)]);
    });
    flush();
  }
  if (opts.hover) attachHover(mount, f, labels, series, opts.hover);
  return f;
}

/** 100%-stacked area chart. Each band is { label, values, color }. */
function stackedArea(mount, labels, bands, opts = {}) {
  // A single point has no area to fill, and zero points produces a path of just "Z",
  // which the SVG parser rejects outright.
  if (labels.length < 2) {
    emptyState(mount, 'Not enough completed quarters to chart yet.');
    return null;
  }
  const f = frame(mount, { labels, top: 100, yFormat: v => v + '%', ...opts });
  const base = new Array(labels.length).fill(0);

  for (const band of bands) {
    const upper = [], lower = [];
    band.values.forEach((v, i) => {
      lower.push([f.x(i), f.y(base[i])]);
      base[i] += v;
      upper.push([f.x(i), f.y(base[i])]);
    });
    f.svg.appendChild(el('path', {
      d: pathFrom(upper) + ' ' + pathFrom(lower.reverse()).replace('M', 'L') + ' Z',
      fill: band.color, opacity: 0.85, stroke: 'none',
    }));
  }
  return f;
}

function barChart(mount, labels, values, color, opts = {}) {
  const f = frame(mount, { labels, top: Math.max(...values, 0), ...opts });
  const slot = f.iw / Math.max(labels.length, 1);
  const w = Math.max(3, slot * 0.62);
  values.forEach((v, i) => {
    const h = f.y(0) - f.y(v);
    if (h <= 0) return;
    f.svg.appendChild(el('rect', { x: f.x(i) - w / 2, y: f.y(v), width: w, height: h, fill: color, rx: 2 }));
  });
  return f;
}

function legend(mount, entries, extra = []) {
  const keys = entries.map(e => {
    const key = document.createElement('span');
    key.className = 'key';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = e.color;
    key.append(sw, document.createTextNode(e.label));
    return key;
  });
  // Non-series entries, e.g. the confidence band, which is easily mistaken for data.
  for (const e of extra) {
    const key = document.createElement('span');
    key.className = 'key';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = e.color;
    sw.style.opacity = '0.3';
    key.append(sw, document.createTextNode(e.label));
    keys.push(key);
  }
  mount.replaceChildren(...keys);
}

function counter(value, label, foot) {
  const box = document.createElement('div');
  box.className = 'counter';
  box.innerHTML = `<div class="value"></div><div class="label"></div><div class="foot"></div>`;
  box.querySelector('.value').textContent = value;
  box.querySelector('.label').textContent = label;
  box.querySelector('.foot').textContent = foot;
  return box;
}

/* --- wiring --- */

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

function renderMarkers(markers) {
  // The current month is still accumulating; plotting it would draw a cliff that
  // looks like a collapse in AI usage rather than an artifact of the run date.
  let months = markers.months.slice();
  let dropped = null;
  if (markers.partial_month && months[months.length - 1] === markers.partial_month) {
    dropped = months.pop();
  }
  const cut = months.length;

  // A null is "not measured yet", not zero — under throttling a full collection takes
  // hours, and plotting an unmeasured month as 0 reads as a collapse in adoption.
  const maxOf = vals => vals.reduce((m, v) => (v == null ? m : Math.max(m, v)), 0);
  const sumOf = vals => vals.reduce((s, v) => s + (v || 0), 0);

  const series = Object.entries(markers.series)
    .map(([label, values], i) => ({ label, values: values.slice(0, cut), color: PALETTE[i % PALETTE.length] }))
    .filter(s => maxOf(s.values) > 0)
    .sort((a, b) => maxOf(b.values) - maxOf(a.values));

  lineChart(document.getElementById('chart-markers'), months.map(m => m.slice(2)), series, {
    height: 340,
    hover: { titles: months, format: fmt },
  });
  legend(document.getElementById('legend-markers'), series);

  if (!series.length) {
    document.getElementById('note-markers').textContent =
      'No attributed commits found — markers.json looks empty. Re-run scripts/ai_markers.py.';
    return;
  }
  const peak = series[0];
  const peakVal = maxOf(peak.values);
  const peakMonth = months[peak.values.indexOf(peakVal)];
  const notes = [`Busiest single tool-month: ${peak.label}, ${fmt(peakVal)} commits in ${peakMonth}.`];
  if (dropped) notes.push(`${dropped} is excluded because it is still in progress.`);
  if (markers.incomplete) {
    notes.push(`Collection is unfinished — ${markers.measured_points} of ${markers.total_points} `
      + `tool-months measured. Lines break where data is missing rather than dropping to zero.`);
  }
  document.getElementById('note-markers').textContent = notes.join(' ');
}

function renderComparison(cmp) {
  const panel = document.getElementById('panel-compare');
  const mount = document.getElementById('chart-compare');
  if (!cmp || !cmp.with_ai_config || !cmp.without) {
    emptyState(mount, 'Not enough repos with AI config files yet to compare fairly.');
    document.getElementById('note-compare').textContent = '';
    return;
  }
  const a = cmp.with_ai_config, b = cmp.without;
  pairedBars(mount, [
    { label: 'has an AI config file', n: a.n, value: a.dead_on_arrival[0],
      lo: a.dead_on_arrival[1], hi: a.dead_on_arrival[2], color: '#4ea3ff' },
    { label: 'everything else', n: b.n, value: b.dead_on_arrival[0],
      lo: b.dead_on_arrival[1], hi: b.dead_on_arrival[2], color: '#ff5c48' },
  ]);

  const ratio = b.dead_on_arrival[0] / Math.max(a.dead_on_arrival[0], 0.01);
  const overlap = a.dead_on_arrival[2] >= b.dead_on_arrival[1];
  document.getElementById('note-compare').textContent = overlap
    ? `Intervals overlap — no reliable difference at this sample size. Quarters compared: ${cmp.quarters_used.join(', ')}.`
    : `Repos with AI instructions are about ${ratio.toFixed(1)}× less likely to be abandoned on day one. `
      + `Intervals do not overlap. Quarters compared: ${cmp.quarters_used.join(', ')}.`;
  panel.style.display = '';
}

function renderCohorts(cohorts, markers = null) {
  const rows = cohorts.cohorts;
  const labels = rows.map(c => c.bucket);

  const fated = rows.filter(c => c.fate);
  const bands = [
    { label: 'never pushed again after day one', key: 'dead_on_arrival', color: '#ff5c48' },
    { label: 'died within 30 days', key: 'died_within_30d', color: '#ffb020' },
    { label: 'died within 90 days', key: 'died_within_90d', color: '#4ea3ff' },
    { label: 'still going after 90 days', key: 'lived_past_90d', color: '#35c98a' },
  ].map(b => ({ ...b, values: fated.map(c => c.fate[b.key]) }));
  const drewFate = stackedArea(document.getElementById('chart-fate'), fated.map(c => c.bucket), bands, { height: 320 });
  legend(document.getElementById('legend-fate'), drewFate ? bands : []);

  const withBand = key => ({
    values: rows.map(c => c[key][0]),
    band: rows.map(c => [c[key][1], c[key][2]]),
  });
  const pctFmt = v => v.toFixed(1) + '%';
  const pct = {
    yFormat: v => v + '%', height: 210, width: 430,
    hover: { titles: labels, format: pctFmt },
  };

  lineChart(document.getElementById('chart-doa'), labels,
    [{ label: 'dead on arrival', color: '#ff5c48', ...withBand('dead_on_arrival') }], pct);
  lineChart(document.getElementById('chart-stars'), labels,
    [{ label: 'zero stars', color: '#ffb020', ...withBand('zero_stars') }], pct);
  // AI detection runs as its own smaller pass, so a cohort can legitimately have no
  // ai_config at all. Chart only the quarters that were actually checked.
  const aiRows = rows.filter(c => c.ai_config);
  if (aiRows.length) {
    // Below this many matching repos the rate is indistinguishable from zero: at
    // ~250 sampled per quarter, one repo is 0.4%. Plotting those points draws tools
    // flickering in and out of existence years before they were released.
    const MIN_HITS = 5;
    const rate = (c, count) => (count >= MIN_HITS ? count / c.ai_checked * 100 : null);

    const toolNames = { claude: 'CLAUDE.md', agents: 'AGENTS.md', cursor: 'Cursor', copilot: 'Copilot', gemini: 'GEMINI.md', cline: 'Cline', windsurf: 'Windsurf', aider: 'aider' };
    const maxOf = vals => vals.reduce((m, v) => (v == null ? m : Math.max(m, v)), 0);
    const toolSeries = Object.keys(aiRows[aiRows.length - 1].ai_counts || {})
      .map(key => ({
        label: toolNames[key] || key,
        values: aiRows.map(c => rate(c, (c.ai_counts || {})[key] || 0)),
        color: null,
      }))
      .filter(s => maxOf(s.values) > 0)
      .sort((a, b) => maxOf(b.values) - maxOf(a.values))
      .map((s, i) => ({ ...s, color: PALETTE[(i + 1) % PALETTE.length] }));

    // The combined series is plotted for every quarter, including the near-zero years.
    // Those were measured — ~250 repos checked, 0 or 1 matched — and hiding them would
    // suggest nobody looked. Its confidence band carries the uncertainty. Only the
    // per-tool lines are suppressed, since those are what flickered on single repos.
    const anySeries = {
      label: 'any AI config file',
      color: '#4ea3ff',
      values: aiRows.map(c => c.ai_any_count / c.ai_checked * 100),
      band: aiRows.map(c => [c.ai_config[1], c.ai_config[2]]),
    };
    // This chart plots a subset of quarters, so its hover labels must come from that
    // subset rather than the full cohort list.
    const aiLabels = aiRows.map(c => c.bucket);
    lineChart(document.getElementById('chart-aicfg'), aiLabels, [anySeries, ...toolSeries],
      { ...pct, hover: { titles: aiLabels, format: pctFmt } });
    legend(document.getElementById('legend-aicfg'), [anySeries, ...toolSeries],
      [{ label: '95% confidence interval', color: '#4ea3ff' }]);

    const avgChecked = Math.round(aiRows.reduce((s, c) => s + c.ai_checked, 0) / aiRows.length);
    const firstReal = aiRows.find(c => c.ai_any_count >= MIN_HITS);
    const widest = aiRows.reduce((w, c) => (c.ai_config[2] > w.ai_config[2] ? c : w), aiRows[0]);
    document.getElementById('note-aicfg').textContent =
      `The shaded band is the 95% confidence interval on the sample, not a second series. `
      + `It is wide early because the sample is small, not because the rate was uncertain in `
      + `some deeper sense — ${widest.bucket} checked only ${fmt(widest.ai_checked)} repos, found `
      + `${widest.ai_any_count}, and that is consistent with anything up to `
      + `${widest.ai_config[2].toFixed(1)}%. `
      + `Every quarter was checked, roughly ${fmt(avgChecked)} repos each; before `
      + `${firstReal ? firstReal.bucket : 'recently'} the answer was zero or one repo, which is why `
      + `the line sits on the floor rather than being absent. Individual tool lines appear only `
      + `once at least ${MIN_HITS} repos in a quarter match.`;
  } else {
    emptyState(document.getElementById('chart-aicfg'),
      'No quarters have been checked for AI config files yet.');
  }

  // Most repos die the same day they are born, so the median is routinely a fraction
  // of a day. "0.01 days" is accurate and useless; switch to hours when it is small.
  const days = rows.map(c => c.median_lifespan_days);
  const useHours = Math.max(...days) < 3;
  const lifeVals = useHours ? days.map(d => d * 24) : days;
  const unit = useHours ? 'h' : 'd';
  barChart(document.getElementById('chart-lifespan'), labels, lifeVals, '#35c98a',
    { height: 210, width: 430, yFormat: v => (v < 10 ? v.toFixed(1) : Math.round(v)) + unit });

  const newest = rows[rows.length - 1];
  const newestLife = useHours
    ? `${(newest.median_lifespan_days * 24).toFixed(1)} hours`
    : `${newest.median_lifespan_days} days`;
  document.getElementById('note-lifespan').textContent =
    `Newest cohort (${newest.bucket}): median lifespan ${newestLife} across ${fmt(newest.n)} sampled repos. ` +
    `More than half never see a second day.`;

  document.getElementById('sample-size').textContent =
    `${fmt(cohorts.total_repos)} repositories sampled across ${rows.length} quarters, ` +
    `target ${fmt(cohorts.sampled_per_quarter)} per quarter. ` +
    `${fmt(cohorts.vanished_between_calls)} disappeared between being listed and being looked up.`;

  // Two counters come from markers.json, which may not exist yet — the search-based
  // collector is throttled independently of the cohort one, so either dataset can
  // land first. Show what we have rather than failing the whole page.
  const cards = [];
  if (markers) {
    const configTotal = Object.values(markers.config_files).reduce((a, b) => a + b, 0);
    // Eight-figure counts do not fit a card. Show the magnitude, keep the exact
    // number in the subtext where there is room for it.
    cards.push(
      counter(fmtShort(markers.total_attributed_commits), 'commits that admit an AI wrote them',
        `${fmt(markers.total_attributed_commits)} since ${markers.months[0]}, ${Object.keys(markers.series).length} tools`),
      counter(fmtShort(configTotal), 'repos carrying AI instruction files',
        Object.entries(markers.config_files).map(([k, v]) => `${k} ${fmtShort(v)}`).join(' · ')),
    );
  }
  const doa = newest.dead_on_arrival[0];
  cards.push(
    counter(doa.toFixed(0) + '%', `of repos born in ${newest.bucket} were never touched again`,
      `95% CI ${newest.dead_on_arrival[1].toFixed(1)}–${newest.dead_on_arrival[2].toFixed(1)}%`),
    counter(newest.zero_stars[0].toFixed(0) + '%', 'of them still have zero stars',
      `${newest.bucket} · median size ${fmtShort(newest.median_disk_kb)} KB`),
  );
  const aiFirst = rows.find(c => c.ai_config);
  const aiLast = [...rows].reverse().find(c => c.ai_config);
  if (aiLast) {
    cards.push(counter(aiLast.ai_config[0].toFixed(1) + '%', 'were built with an AI tool watching',
      aiFirst && aiFirst !== aiLast
        ? `${aiLast.bucket}, up from ${aiFirst.ai_config[0].toFixed(1)}% in ${aiFirst.bucket}`
        : `${aiLast.bucket}, n=${fmt(aiLast.ai_checked)}`));
  }
  document.getElementById('counters').replaceChildren(...cards);

  renderComparison(cohorts.ai_vs_rest);

  const list = document.getElementById('query-list');
  list.replaceChildren(...Object.entries((markers && markers.queries) || {}).map(([label, q]) => {
    const li = document.createElement('li');
    li.innerHTML = '<b></b> ';
    li.querySelector('b').textContent = label + ':';
    li.append(document.createTextNode(q));
    return li;
  }));
}

(async function main() {
  try {
    // Cohorts are required; markers are optional so a throttled or partial collection
    // still produces a usable page.
    const [cohorts, markers] = await Promise.all([
      loadJSON('data/cohorts.json'),
      loadJSON('data/markers.json').catch(() => null),
    ]);
    if (markers) {
      renderMarkers(markers);
    } else {
      emptyState(document.getElementById('chart-markers'),
        'Commit-attribution data not collected yet — run scripts/ai_markers.py.');
      document.getElementById('note-markers').textContent = '';
    }
    renderCohorts(cohorts, markers);

    const generatedAt = cohorts.generated_at || (markers && markers.generated_at);
    document.getElementById('last-updated').textContent = generatedAt
      ? `Data last collected ${new Date(generatedAt).toLocaleString('en-US', {
          dateStyle: 'medium', timeStyle: 'short',
        })}`
      : 'Data collection time unknown.';
  } catch (err) {
    document.getElementById('counters').innerHTML =
      `<div class="error">Could not load site/data/*.json — ${err.message}.<br>` +
      `Run scripts/ai_markers.py and scripts/sample_repos.py, then reload.</div>`;
  }
})();
