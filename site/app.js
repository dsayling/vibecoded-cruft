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
const pct1 = v => v.toFixed(1) + '%';
/** "3.2 h" / "9.4 d" — lifespans span four orders of magnitude across quarters. */
const fmtDays = d => (d < 1 ? `${(d * 24).toFixed(1)} h` : `${d.toFixed(d < 10 ? 1 : 0)} d`);

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
function frame(mount, { labels, top, height = 320, yFormat = fmtShort, width = 860, title }) {
  // The viewBox is scaled to fit its container, so a chart in a half-width panel needs
  // a narrower viewBox or its 10px labels render at about 4px on screen.
  const W = width;
  const H = height;
  const M = { t: 16, r: 14, b: 34, l: 52 };
  const iw = W - M.l - M.r;
  const ih = H - M.t - M.b;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  // Without this the chart is an unlabelled graphic: a screen reader announces nothing
  // at all. The matching data table below each chart carries the actual numbers.
  if (title) {
    svg.appendChild(el('title', {}, title));
    svg.setAttribute('aria-label', title);
  }
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
    // A centred label at either end hangs outside the viewBox and gets clipped — the
    // final quarter used to render as "2026Q" on the half-width charts.
    const half = (labels[i].length * approxCharW) / 2;
    const anchor = x(i) + half > W - 2 ? 'end' : x(i) - half < 2 ? 'start' : 'middle';
    svg.appendChild(el('text', { class: 'tick', x: x(i), y: H - 12, 'text-anchor': anchor }, labels[i]));
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

/* --- the numbers behind the picture ---------------------------------------- */

function toCSV(columns, rows) {
  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(','), ...rows.map(r => r.map(cell).join(','))].join('\n');
}

/**
 * Append a collapsed data table under a chart.
 *
 * Two jobs at once. A page arguing that its own numbers deserve scrutiny should not
 * make them impossible to read off, and every chart here is an <svg role="img"> that
 * a screen reader would otherwise announce as nothing whatsoever.
 */
function dataTable(panel, { name, columns, rows, describes }) {
  if (!rows.length) return;
  const details = document.createElement('details');
  details.className = 'datatable';

  const summary = document.createElement('summary');
  summary.textContent = `Show the numbers (${fmt(rows.length)} rows)`;
  details.appendChild(summary);

  const bar = document.createElement('div');
  bar.className = 'dt-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy CSV';
  copy.addEventListener('click', async () => {
    const csv = toCSV(columns, rows);
    try {
      await navigator.clipboard.writeText(csv);
      copy.textContent = 'Copied';
    } catch {
      // Clipboard access needs a secure context; fall back to selecting the text so
      // the reader can still copy it by hand rather than getting nothing.
      const ta = document.createElement('textarea');
      ta.className = 'dt-fallback';
      ta.value = csv;
      ta.readOnly = true;
      bar.after(ta);
      ta.select();
      copy.textContent = 'Select all + copy';
    }
    setTimeout(() => { copy.textContent = 'Copy CSV'; }, 2500);
  });
  bar.appendChild(copy);
  details.appendChild(bar);

  const scroll = document.createElement('div');
  scroll.className = 'dt-scroll';
  const table = document.createElement('table');
  if (describes) table.id = describes;
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const c of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = c;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    row.forEach((v, i) => {
      const cell = document.createElement(i === 0 ? 'th' : 'td');
      if (i === 0) cell.scope = 'row';
      cell.textContent = v == null ? '—' : v;
      tr.appendChild(cell);
    });
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  scroll.appendChild(table);
  details.appendChild(scroll);

  const caption = document.createElement('caption');
  caption.textContent = name;
  table.prepend(caption);

  panel.appendChild(details);
}

/** Wire a chart's svg to the table that carries its values. */
function describeChart(mount, tableId) {
  const svg = mount.querySelector('svg');
  if (svg && tableId) svg.setAttribute('aria-describedby', tableId);
}

/* --- charts ----------------------------------------------------------------- */

/** Horizontal bars with confidence whiskers, one row per group. */
function barsH(mount, groups, opts = {}) {
  const rowH = opts.rowH || 76;
  const W = 860, H = groups.length * rowH + 30;
  const M = { t: 10, r: 90, l: opts.labelWidth || 200 };
  const iw = W - M.l - M.r;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  if (opts.title) {
    svg.appendChild(el('title', {}, opts.title));
    svg.setAttribute('aria-label', opts.title);
  }
  const top = Math.max(...groups.map(g => g.hi), 10);
  const x = v => M.l + (v / top) * iw;
  const barH = Math.min(30, rowH - 16);

  groups.forEach((g, i) => {
    const y = M.t + i * rowH;
    const mid = y + 8 + barH / 2;
    svg.appendChild(el('text', { class: 'tick', x: M.l - 14, y: y + barH / 2 + 4, 'text-anchor': 'end',
      style: 'font-size:14px;fill:var(--ink)' }, g.label));
    if (g.sub) {
      svg.appendChild(el('text', { class: 'tick', x: M.l - 14, y: y + barH / 2 + 20, 'text-anchor': 'end' }, g.sub));
    }
    svg.appendChild(el('rect', { x: M.l, y: y + 8, width: Math.max(1, x(g.value) - M.l),
      height: barH, fill: g.color, rx: 3 }));
    // Whisker: the interval is the point of showing this at all.
    svg.appendChild(el('line', { x1: x(g.lo), x2: x(g.hi), y1: mid, y2: mid,
      stroke: 'var(--ink)', 'stroke-width': 1.5, opacity: 0.55 }));
    for (const b of [g.lo, g.hi]) {
      svg.appendChild(el('line', { x1: x(b), x2: x(b), y1: mid - 8, y2: mid + 8,
        stroke: 'var(--ink)', 'stroke-width': 1.5, opacity: 0.55 }));
    }
    svg.appendChild(el('text', { x: x(g.value) + 12, y: mid + 5,
      style: 'font-size:16px;font-weight:700;fill:var(--ink)', class: 'tick' },
      g.value.toFixed(1) + '%'));
  });
  mount.replaceChildren(svg);
}

/**
 * Crosshair + readout on hover. The chart scales its viewBox to the container, so
 * pointer coordinates have to be mapped back through the rendered size rather than
 * read directly.
 */
function attachHover(mount, f, labels, series, opts = {}) {
  const { titles = labels, format = fmt, subtitle = null, pointAt = null } = opts;
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
      dots[k].setAttribute('cy', f.y(pointAt ? pointAt(k, i) : v));
      dots[k].setAttribute('opacity', 1);
      rows.push(`<div class="row"><span class="k"><i style="background:${s.color}"></i>${s.label}</span><b>${format(v, i, s)}</b></div>`);
    });

    // Sample size belongs next to every number on this page: the cohorts run from 1,174
    // to 3,286 repos and the AI subsample is a tenth of that, which is the difference
    // between a measurement and a rumour.
    const sub = subtitle ? subtitle(i) : null;
    tip.innerHTML = `<div class="when">${titles[i]}${sub ? `<span class="n">${sub}</span>` : ''}</div>`
      + (rows.join('') || '<div class="when">not measured</div>');
    tip.hidden = false;
    // Fixed positioning, clamped to the viewport rather than the chart container:
    // the container clips overflow on both axes, and a six-series tooltip is
    // routinely taller than a short mobile chart. Measuring the rendered box lets
    // us flip and clamp against what actually got laid out (CI text, long labels).
    const px = rect.left + (f.x(i) / f.W) * rect.width;
    const py = rect.top + (f.M.t / f.H) * rect.height;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = px + 14 + tw > window.innerWidth ? px - tw - 14 : px + 14;
    left = Math.max(4, Math.min(left, window.innerWidth - tw - 4));
    const top = Math.max(4, Math.min(py, window.innerHeight - th - 4));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
    tip.style.transform = 'none';
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

/**
 * Unconnected dots with confidence whiskers.
 *
 * For series that describe each quarter's present state rather than a trend. A
 * connected line is itself a claim — that the gap between two points means something —
 * and for stars or lifespan that claim is false, because a 2020 repo has had six years
 * to collect a star and a 2026 one has had weeks. The page used to make the claim in
 * ink and then retract it in a footnote; not drawing the line says it once.
 */
function dotChart(mount, labels, series, opts = {}) {
  const top = Math.max(
    ...series.flatMap(s => s.values.filter(v => v != null)),
    ...series.flatMap(s => (s.band || []).map(b => b[1])),
    0,
  );
  const f = frame(mount, { labels, top, ...opts });

  for (const s of series) {
    s.values.forEach((v, i) => {
      if (v == null) return;
      if (s.band && s.band[i]) {
        const [lo, hi] = s.band[i];
        f.svg.appendChild(el('line', { x1: f.x(i), x2: f.x(i), y1: f.y(lo), y2: f.y(hi),
          stroke: s.color, 'stroke-width': 1.5, opacity: 0.5 }));
      }
      f.svg.appendChild(el('circle', { cx: f.x(i), cy: f.y(v), r: 3.4, fill: s.color }));
    });
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
  const tops = [];

  for (const band of bands) {
    const upper = [], lower = [];
    band.values.forEach((v, i) => {
      lower.push([f.x(i), f.y(base[i])]);
      base[i] += v;
      upper.push([f.x(i), f.y(base[i])]);
    });
    tops.push(base.slice());
    f.svg.appendChild(el('path', {
      d: pathFrom(upper) + ' ' + pathFrom(lower.reverse()).replace('M', 'L') + ' Z',
      fill: band.color, opacity: 0.85, stroke: 'none',
    }));
  }
  // Dots ride the top of each band rather than its raw share, or they land in the
  // wrong stripe entirely.
  if (opts.hover) {
    attachHover(mount, f, labels, bands, { ...opts.hover, pointAt: (k, i) => tops[k][i] });
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
  if (opts.hover) {
    attachHover(mount, f, labels, [{ label: opts.seriesLabel || 'value', values, color }], opts.hover);
  }
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

const panelOf = id => document.getElementById(id).closest('.panel');

function renderMarkers(markers) {
  // The current month is still accumulating; plotting it would draw a cliff that
  // looks like a collapse in AI usage rather than an artifact of the run date.
  let months = markers.months.slice();
  let dropped = null;
  if (markers.partial_month && months[months.length - 1] === markers.partial_month) {
    dropped = months.pop();
  }
  const cut = months.length;

  // Plot the collision-adjusted counts where the collector published them. The raw
  // series shows hundreds of Devin "AI commits" a month through 2022, two years before
  // Devin existed — those are humans called Devin, and the floor subtracts them.
  const source = markers.series_adjusted || markers.series;
  const floors = markers.collision_floors || {};

  // A null is "not measured yet", not zero — under throttling a full collection takes
  // hours, and plotting an unmeasured month as 0 reads as a collapse in adoption.
  const maxOf = vals => vals.reduce((m, v) => (v == null ? m : Math.max(m, v)), 0);

  const series = Object.entries(source)
    .map(([label, values], i) => ({ label, values: values.slice(0, cut), color: PALETTE[i % PALETTE.length] }))
    .filter(s => maxOf(s.values) > 0)
    .sort((a, b) => maxOf(b.values) - maxOf(a.values));

  const spread = markers.series_spread || {};
  lineChart(document.getElementById('chart-markers'), months.map(m => m.slice(2)), series, {
    height: 340,
    title: 'Monthly commits carrying an AI attribution trailer, by tool',
    hover: {
      titles: months,
      format: (v, i, s) => {
        const sp = (spread[s.label] || [])[i];
        // Where a cell was sampled more than once, show what the estimator actually
        // did rather than pretending the median was a reading.
        return sp ? `${fmt(v)} <span class="spread">(${fmtShort(sp[0])}–${fmtShort(sp[1])})</span>` : fmt(v);
      },
    },
  });
  legend(document.getElementById('legend-markers'), series);
  describeChart(document.getElementById('chart-markers'), 'tbl-markers');

  dataTable(panelOf('chart-markers'), {
    name: 'AI-attributed commits per month, collision-adjusted',
    describes: 'tbl-markers',
    columns: ['Month', ...series.map(s => s.label)],
    rows: months.map((m, i) => [m, ...series.map(s => (s.values[i] == null ? null : s.values[i]))]),
  });

  if (!series.length) {
    document.getElementById('note-markers').textContent =
      'No attributed commits found — markers.json looks empty. Re-run scripts/ai_markers.py.';
    return;
  }
  const peak = series[0];
  const peakVal = maxOf(peak.values);
  const peakMonth = months[peak.values.indexOf(peakVal)];
  const notes = [`Busiest single tool-month: ${peak.label}, ${fmt(peakVal)} commits in ${peakMonth}.`];

  const measured = Object.entries(floors).filter(([, f]) => f && f.per_month > 0);
  if (measured.length) {
    measured.sort((a, b) => b[1].per_month - a[1].per_month);
    notes.push(
      'Every line has its name-collision floor subtracted: '
      + measured.map(([k, f]) => `${k} −${fmt(Math.round(f.per_month))}/mo`).join(', ')
      + '. Each floor is the median monthly hit count over the months before that tool '
      + 'shipped, when a hit could only be a human with the same name.'
    );
  }
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
  barsH(mount, [
    { label: 'has an AI config file', sub: `n = ${fmt(a.n)}`, value: a.dead_on_arrival[0],
      lo: a.dead_on_arrival[1], hi: a.dead_on_arrival[2], color: '#4ea3ff' },
    { label: 'everything else', sub: `n = ${fmt(b.n)}`, value: b.dead_on_arrival[0],
      lo: b.dead_on_arrival[1], hi: b.dead_on_arrival[2], color: '#ff5c48' },
  ], { title: 'Dead-on-arrival rate, repos with an AI config file versus everything else' });
  describeChart(mount, 'tbl-compare');

  const ratio = b.dead_on_arrival[0] / Math.max(a.dead_on_arrival[0], 0.01);
  const overlap = a.dead_on_arrival[2] >= b.dead_on_arrival[1];
  document.getElementById('note-compare').textContent = (overlap
    ? `Intervals overlap — no reliable difference at this sample size. `
    : `Repos with AI instructions are about ${ratio.toFixed(1)}× less likely to be abandoned on day one. `
      + `Intervals do not overlap. `)
    + `Quarters compared: ${cmp.quarters_used.join(', ')}. `
    + `The whole claim rests on ${fmt(a.n)} repos carrying a config file.`;

  dataTable(panel, {
    name: 'Dead on arrival, by quarter and group',
    describes: 'tbl-compare',
    columns: ['Quarter', 'n (AI config)', 'DOA % (AI config)', '95% CI', 'n (rest)', 'DOA % (rest)', '95% CI'],
    rows: (cmp.per_quarter || []).map(p => [
      p.bucket, p.n_ai, p.with_ai_config[0], `${p.with_ai_config[1]}–${p.with_ai_config[2]}`,
      p.n_rest, p.without[0], `${p.without[1]}–${p.without[2]}`,
    ]),
  });
  panel.style.display = '';
}

function renderLanguages(langs) {
  const panel = document.getElementById('panel-langs');
  const mount = document.getElementById('chart-langs');
  if (!langs || !(langs.rows || []).length) {
    // Language lands in cohorts.json only after a re-run of the collector, so an older
    // data file simply does not get this panel.
    panel.style.display = 'none';
    return;
  }
  const rows = langs.rows.slice(0, 12);
  barsH(mount, rows.map((r, i) => ({
    label: r.lang,
    sub: `n = ${fmt(r.n)} · ${r.share.toFixed(1)}% of sample`,
    value: r.dead_on_arrival[0],
    lo: r.dead_on_arrival[1],
    hi: r.dead_on_arrival[2],
    color: PALETTE[i % PALETTE.length],
  })), { rowH: 52, labelWidth: 210, title: 'Dead-on-arrival rate by primary language' });
  describeChart(mount, 'tbl-langs');

  document.getElementById('note-langs').textContent =
    `${fmt(langs.n_total)} repos across ${langs.quarters_used.join(', ')}, languages with at least `
    + `${langs.min_n} repos. Dead-on-arrival is a fixed one-day window, so unlike stars it is `
    + `comparable between groups. "(none detected)" is mostly empty repos and plain-text ones.`;

  dataTable(panel, {
    name: 'Dead on arrival by language',
    describes: 'tbl-langs',
    columns: ['Language', 'n', 'Share %', 'DOA %', '95% CI', 'Zero stars %'],
    rows: langs.rows.map(r => [
      r.lang, r.n, r.share, r.dead_on_arrival[0],
      `${r.dead_on_arrival[1]}–${r.dead_on_arrival[2]}`, r.zero_stars[0],
    ]),
  });
}

function renderCohorts(cohorts, markers = null) {
  const rows = cohorts.cohorts;
  const labels = rows.map(c => c.bucket);
  const nAt = i => `n = ${fmt(rows[i].n)}`;
  const ci = (c, key) => `${c[key][1].toFixed(1)}–${c[key][2].toFixed(1)}`;

  /* --- how a repository dies (100% stacked) --- */
  const fated = rows.filter(c => c.fate);
  const bands = [
    { label: 'never pushed again after day one', key: 'dead_on_arrival', color: '#ff5c48' },
    { label: 'died within 30 days', key: 'died_within_30d', color: '#ffb020' },
    { label: 'died within 90 days', key: 'died_within_90d', color: '#4ea3ff' },
    { label: 'still going after 90 days', key: 'lived_past_90d', color: '#35c98a' },
  ].map(b => ({ ...b, values: fated.map(c => c.fate[b.key]) }));
  const fateLabels = fated.map(c => c.bucket);
  const drewFate = stackedArea(document.getElementById('chart-fate'), fateLabels, bands, {
    height: 320,
    title: 'Share of each quarterly cohort by how long it survived',
    hover: {
      titles: fateLabels,
      format: pct1,
      subtitle: i => `n = ${fmt(fated[i].n)}`,
    },
  });
  legend(document.getElementById('legend-fate'), drewFate ? bands : []);
  if (drewFate) {
    describeChart(document.getElementById('chart-fate'), 'tbl-fate');
    dataTable(panelOf('chart-fate'), {
      name: 'Share of each cohort by fate',
      describes: 'tbl-fate',
      columns: ['Quarter', 'n', ...bands.map(b => b.label)],
      rows: fateLabels.map((q, i) => [q, fated[i].n, ...bands.map(b => b.values[i])]),
    });
  }

  const withBand = key => ({
    values: rows.map(c => (c[key] ? c[key][0] : null)),
    band: rows.map(c => (c[key] ? [c[key][1], c[key][2]] : null)),
  });
  const pct = { yFormat: v => v + '%', height: 210, width: 430 };
  const withCI = key => (v, i) => `${v.toFixed(1)}% <span class="spread">[${ci(rows[i], key)}]</span>`;

  /* --- how fast they die: three fixed windows, all comparable across cohorts --- */
  const deathSeries = [
    { label: 'dead on arrival', color: '#ff5c48', key: 'dead_on_arrival', ...withBand('dead_on_arrival') },
    { label: 'dead within 30 days', color: '#ffb020', key: 'dead_within_30d', ...withBand('dead_within_30d') },
    { label: 'dead within 90 days', color: '#4ea3ff', key: 'dead_within_90d', ...withBand('dead_within_90d') },
  ].filter(s => s.values.some(v => v != null));
  // Only the headline series carries a band; three overlapping shadings is mud.
  deathSeries.forEach((s, i) => { if (i) delete s.band; });
  lineChart(document.getElementById('chart-doa'), labels, deathSeries, {
    ...pct,
    title: 'Share of each cohort dead on arrival, within 30 days, and within 90 days',
    hover: {
      titles: labels,
      subtitle: nAt,
      format: (v, i, s) => `${v.toFixed(1)}%` + (s.key === 'dead_on_arrival' ? ` <span class="spread">[${ci(rows[i], s.key)}]</span>` : ''),
    },
  });
  legend(document.getElementById('legend-doa'), deathSeries,
    [{ label: '95% confidence interval', color: '#ff5c48' }]);
  describeChart(document.getElementById('chart-doa'), 'tbl-doa');
  dataTable(panelOf('chart-doa'), {
    name: 'Death rates over fixed windows',
    describes: 'tbl-doa',
    columns: ['Quarter', 'n', 'DOA %', '95% CI', '≤30d %', '≤90d %'],
    rows: rows.map(c => [
      c.bucket, c.n, c.dead_on_arrival[0], ci(c, 'dead_on_arrival'),
      c.dead_within_30d ? c.dead_within_30d[0] : null,
      c.dead_within_90d ? c.dead_within_90d[0] : null,
    ]),
  });

  /* --- zero stars: present state, so dots rather than a line --- */
  dotChart(document.getElementById('chart-stars'), labels,
    [{ label: 'zero stars', color: '#ffb020', ...withBand('zero_stars') }], {
      ...pct,
      title: 'Share of each cohort still sitting at zero stars, with 95% intervals',
      hover: { titles: labels, subtitle: nAt, format: withCI('zero_stars') },
    });
  describeChart(document.getElementById('chart-stars'), 'tbl-stars');
  dataTable(panelOf('chart-stars'), {
    name: 'Repos at exactly zero stars',
    describes: 'tbl-stars',
    columns: ['Quarter', 'n', 'Zero stars %', '95% CI'],
    rows: rows.map(c => [c.bucket, c.n, c.zero_stars[0], ci(c, 'zero_stars')]),
  });

  /* --- AI config files --- */
  const aiRows = rows.filter(c => c.ai_config);
  if (aiRows.length) {
    // Below this many matching repos the rate is indistinguishable from zero: at
    // ~250 sampled per quarter, one repo is 0.4%. Plotting those points draws tools
    // flickering in and out of existence years before they were released.
    const MIN_HITS = 5;
    const rate = (c, count) => (count >= MIN_HITS ? count / c.ai_checked * 100 : null);

    const toolNames = { claude: 'CLAUDE.md', agents: 'AGENTS.md', cursor: 'Cursor', copilot: 'Copilot', gemini: 'GEMINI.md', cline: 'Cline', windsurf: 'Windsurf', aider: 'aider' };
    const maxOf = vals => vals.reduce((m, v) => (v == null ? m : Math.max(m, v)), 0);
    const toolKeys = Object.keys(aiRows[aiRows.length - 1].ai_counts || {});
    const toolSeries = toolKeys
      .map(key => ({
        key,
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
      key: 'any',
      label: 'any AI config file',
      color: '#4ea3ff',
      values: aiRows.map(c => c.ai_any_count / c.ai_checked * 100),
      band: aiRows.map(c => [c.ai_config[1], c.ai_config[2]]),
    };
    // This chart plots a subset of quarters, so its hover labels must come from that
    // subset rather than the full cohort list.
    const aiLabels = aiRows.map(c => c.bucket);
    lineChart(document.getElementById('chart-aicfg'), aiLabels, [anySeries, ...toolSeries], {
      ...pct,
      title: 'Share of sampled repos carrying an AI coding-agent config file',
      hover: {
        titles: aiLabels,
        // This subsample is roughly a tenth of the cohort in most quarters, so its own
        // denominator is the number that matters, not the cohort's.
        subtitle: i => `${fmt(aiRows[i].ai_checked)} repos checked`,
        format: (v, i, s) => {
          // ai_by_tool carries the interval the collector already computed per tool.
          const band = s.key === 'any' ? aiRows[i].ai_config : (aiRows[i].ai_by_tool || {})[s.key];
          return `${v.toFixed(1)}%` + (band ? ` <span class="spread">[${band[1].toFixed(1)}–${band[2].toFixed(1)}]</span>` : '');
        },
      },
    });
    legend(document.getElementById('legend-aicfg'), [anySeries, ...toolSeries],
      [{ label: '95% confidence interval', color: '#4ea3ff' }]);
    describeChart(document.getElementById('chart-aicfg'), 'tbl-aicfg');
    dataTable(panelOf('chart-aicfg'), {
      name: 'Repos carrying an AI config file',
      describes: 'tbl-aicfg',
      columns: ['Quarter', 'Repos checked', 'Any %', '95% CI', ...toolSeries.map(s => s.label + ' n')],
      rows: aiRows.map((c, i) => [
        c.bucket, c.ai_checked, +(c.ai_any_count / c.ai_checked * 100).toFixed(2),
        `${c.ai_config[1]}–${c.ai_config[2]}`,
        ...toolSeries.map(s => (c.ai_counts || {})[s.key] ?? 0),
      ]),
    });

    const avgChecked = Math.round(aiRows.reduce((s, c) => s + c.ai_checked, 0) / aiRows.length);
    const firstReal = aiRows.find(c => c.ai_any_count >= MIN_HITS);
    const widest = aiRows.reduce((w, c) => (c.ai_config[2] > w.ai_config[2] ? c : w), aiRows[0]);
    document.getElementById('note-aicfg').textContent =
      `Checked on a separate, much smaller pass than the rest of the page: roughly `
      + `${fmt(avgChecked)} repos per quarter against ${fmt(Math.round(rows.reduce((s, c) => s + c.n, 0) / rows.length))} `
      + `in the main cohort. The shaded band is the 95% interval on that subsample, not a `
      + `second series. It is wide early because the sample is small — ${widest.bucket} checked `
      + `${fmt(widest.ai_checked)} repos, found ${widest.ai_any_count}, and that is consistent with `
      + `anything up to ${widest.ai_config[2].toFixed(1)}%. Before `
      + `${firstReal ? firstReal.bucket : 'recently'} the answer was zero or one repo, which is why `
      + `the line sits on the floor rather than being absent. Individual tool lines appear only `
      + `once at least ${MIN_HITS} repos in a quarter match.`;
  } else {
    emptyState(document.getElementById('chart-aicfg'),
      'No quarters have been checked for AI config files yet.');
  }

  /* --- lifespan: the median is pinned inside day one, so plot the tail --- */
  const hasPct = rows.some(c => c.lifespan_p75_days != null);
  const lifeKey = hasPct ? 'lifespan_p75_days' : 'median_lifespan_days';
  const lifeVals = rows.map(c => c[lifeKey] ?? 0);
  // Sub-day values are routine here, so the axis switches to hours when it has to.
  const useHours = Math.max(...lifeVals) < 3;
  const plotted = useHours ? lifeVals.map(d => d * 24) : lifeVals;
  const unit = useHours ? 'h' : 'd';
  barChart(document.getElementById('chart-lifespan'), labels, plotted, '#35c98a', {
    height: 210, width: 430,
    yFormat: v => (v < 10 ? v.toFixed(1) : Math.round(v)) + unit,
    title: hasPct
      ? '75th-percentile repository lifespan by quarter'
      : 'Median repository lifespan by quarter',
    seriesLabel: hasPct ? '75th percentile' : 'median',
    hover: {
      titles: labels,
      subtitle: nAt,
      format: (v, i) => {
        const c = rows[i];
        return hasPct
          ? `${fmtDays(c.lifespan_p75_days)} <span class="spread">(p90 ${fmtDays(c.lifespan_p90_days)}, median ${fmtDays(c.median_lifespan_days)})</span>`
          : fmtDays(c.median_lifespan_days);
      },
    },
  });
  describeChart(document.getElementById('chart-lifespan'), 'tbl-life');
  dataTable(panelOf('chart-lifespan'), {
    name: 'Repository lifespan, days from creation to final push',
    describes: 'tbl-life',
    columns: ['Quarter', 'n', 'Median (d)', 'p75 (d)', 'p90 (d)'],
    rows: rows.map(c => [c.bucket, c.n, c.median_lifespan_days, c.lifespan_p75_days ?? null, c.lifespan_p90_days ?? null]),
  });

  const newest = rows[rows.length - 1];
  document.getElementById('note-lifespan').textContent = hasPct
    ? `Plotted at the 75th percentile. The median is useless here and always will be: more `
      + `than half of every cohort dies on day one, so the median is pinned inside the first `
      + `24 hours for all ${rows.length} quarters (${fmtDays(newest.median_lifespan_days)} in `
      + `${newest.bucket}) and measures the floor rather than the cohort. Three-quarters of `
      + `${newest.bucket} was finished within ${fmtDays(newest.lifespan_p75_days)}.`
    : `Newest cohort (${newest.bucket}): median lifespan ${fmtDays(newest.median_lifespan_days)} `
      + `across ${fmt(newest.n)} sampled repos. More than half never see a second day. `
      + `Re-run the collector to publish the 75th and 90th percentiles, which are not pinned `
      + `to the day-one floor the way the median is.`;

  /* --- the fields the collector has always published and nobody drew --- */
  const other = [
    { label: 'zero forks', color: '#c084fc', ...withBand('zero_forks') },
    { label: 'archived', color: '#7dd3fc', ...withBand('archived') },
    { label: 'empty (no commits)', color: '#f472b6', ...withBand('empty') },
  ].filter(s => s.values.some(v => v != null));
  other.forEach(s => delete s.band);
  const otherPanel = document.getElementById('panel-other');
  if (other.length) {
    dotChart(document.getElementById('chart-other'), labels, other, {
      height: 240,
      title: 'Share of each cohort with zero forks, archived, or holding no commits',
      hover: { titles: labels, subtitle: nAt, format: pct1 },
    });
    legend(document.getElementById('legend-other'), other);
    describeChart(document.getElementById('chart-other'), 'tbl-other');
    const emptyChecked = rows.some(c => c.empty_checked);
    document.getElementById('note-other').textContent =
      'Dots, not lines, for the same reason as the star chart: forks and archive flags '
      + 'accumulate with exposure, so each quarter reads on its own.'
      + (emptyChecked
        ? ' "Empty" is measured only on the GraphQL sample, which reports it directly — repo '
          + 'size is rounded to whole KB, so deriving it from size would call any repo with a '
          + 'short README empty.'
        : '');
    dataTable(otherPanel, {
      name: 'Zero forks, archived and empty',
      describes: 'tbl-other',
      columns: ['Quarter', 'n', 'Zero forks %', 'Archived %', 'Empty %', 'Empty checked'],
      rows: rows.map(c => [
        c.bucket, c.n, c.zero_forks[0], c.archived[0],
        c.empty ? c.empty[0] : null, c.empty_checked ?? null,
      ]),
    });
  } else {
    otherPanel.style.display = 'none';
  }

  /* --- methodology footer --- */
  const age = cohorts.observation_age_days;
  document.getElementById('sample-size').textContent =
    `${fmt(cohorts.total_repos)} repositories sampled across ${rows.length} quarters, `
    + `target ${fmt(cohorts.sampled_per_quarter)} per quarter. `
    + `${fmt(cohorts.vanished_between_calls)} disappeared between being listed and being looked up.`
    + (age
      ? ` Repos were last read a median of ${age.median} days ago (oldest ${age.max}); `
        + `every metric here compares a stored timestamp against a clock, so that is the `
        + `shelf life of the numbers.`
      : '');

  /* --- headline counters --- */
  const cards = [];
  if (markers) {
    const annual = markers.total_attributed_commits_annual;
    const monthly = markers.total_attributed_commits;
    if (annual && monthly) {
      // Counting the same commits by month and by year should agree and does not — 2.5x
      // apart, and 86% of the gap is the single largest series. Showing one end of that
      // range as a fact would be picking the flattering answer.
      cards.push(counter(
        `${fmtShort(annual)}–${fmtShort(monthly)}`,
        'commits that admit an AI wrote them',
        `GitHub's search estimator disagrees with itself by ${(monthly / annual).toFixed(1)}×: `
        + `${fmt(annual)} counted by year, ${fmt(monthly)} by month. Since ${markers.months[0]}.`,
      ));
    } else {
      cards.push(counter(fmtShort(monthly || 0), 'commits that admit an AI wrote them',
        `${fmt(monthly || 0)} since ${markers.months[0]}, ${Object.keys(markers.series).length} tools`));
    }
    const configTotal = Object.values(markers.config_files).reduce((a, b) => a + b, 0);
    // These are file matches, not repos, and a repo commonly carries several — in the
    // 2026Q3 sample, 33 repos with any AI config account for 50 CLAUDE.md + AGENTS.md
    // hits. Summing them and calling the result a repo count roughly doubles it.
    cards.push(
      counter(fmtShort(configTotal), 'AI instruction files indexed by code search',
        `${Object.entries(markers.config_files).map(([k, v]) => `${k} ${fmtShort(v)}`).join(' · ')} `
        + `— files, not repos; most repos carry more than one`),
    );
  }
  const newestDoa = newest.dead_on_arrival;
  cards.push(
    counter(newestDoa[0].toFixed(0) + '%', `of repos born in ${newest.bucket} were never touched again`,
      `95% CI ${newestDoa[1].toFixed(1)}–${newestDoa[2].toFixed(1)}% · n = ${fmt(newest.n)}`),
    counter(newest.zero_stars[0].toFixed(0) + '%', 'of them still have zero stars',
      `95% CI ${newest.zero_stars[1].toFixed(1)}–${newest.zero_stars[2].toFixed(1)}% · n = ${fmt(newest.n)}`),
  );
  const aiLast = [...rows].reverse().find(c => c.ai_config);
  if (aiLast) {
    // Every other card on this row shows its interval; this one used to be the sole
    // exception, and it is the thinnest sample of the lot.
    cards.push(counter(aiLast.ai_config[0].toFixed(1) + '%',
      `of ${aiLast.bucket} repos carry a config file for a coding agent`,
      `95% CI ${aiLast.ai_config[1].toFixed(1)}–${aiLast.ai_config[2].toFixed(1)}% · `
      + `n = ${fmt(aiLast.ai_checked)} checked · read as the repo stands today, not on day one`));
  }
  document.getElementById('counters').replaceChildren(...cards);

  renderComparison(cohorts.ai_vs_rest);
  renderLanguages(cohorts.languages);

  const list = document.getElementById('query-list');
  list.replaceChildren(...Object.entries((markers && markers.queries) || {}).map(([label, q]) => {
    const li = document.createElement('li');
    li.innerHTML = '<b></b> ';
    li.querySelector('b').textContent = label + ':';
    li.append(document.createTextNode(q));
    const floor = ((markers && markers.collision_floors) || {})[label];
    if (floor && floor.per_month > 0) {
      const s = document.createElement('span');
      s.className = 'floor';
      s.textContent = ` − ${fmt(Math.round(floor.per_month))}/mo collision floor `
        + `(median of ${floor.baseline_months} months to ${floor.baseline_until})`;
      li.append(s);
    }
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
    const age = cohorts.observation_age_days;
    document.getElementById('last-updated').textContent = generatedAt
      ? `Data last collected ${new Date(generatedAt).toLocaleString('en-US', {
          dateStyle: 'medium', timeStyle: 'short',
        })}` + (age ? ` · repos last read a median of ${age.median} days ago` : '')
      : 'Data collection time unknown.';
  } catch (err) {
    document.getElementById('counters').innerHTML =
      `<div class="error">Could not load site/data/*.json — ${err.message}.<br>` +
      `Run scripts/ai_markers.py and scripts/sample_repos.py, then reload.</div>`;
  }
})();
