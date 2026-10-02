import { DAY, SOURCES } from "./analytics.js";

export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const formatNumber = (value, digits = 1) =>
  Number.isFinite(value)
    ? (Math.round(value * 10 ** digits) / 10 ** digits || 0).toLocaleString(
        undefined,
        { maximumFractionDigits: digits },
      )
    : "—";
export const formatDay = (t, full = false) =>
  Number.isFinite(t)
    ? new Date(t).toLocaleDateString(undefined, {
        day: "numeric",
        month: "short",
        ...(full ? { year: "numeric" } : {}),
        timeZone: "UTC",
      })
    : "No date";
const colorOf = (s) => s.color || SOURCES[s.key]?.color || "#777";

export function sparkline(points, color = "#3185d6") {
  if (points.length < 2) return "";
  const values = points.map((p) => p.v),
    low = Math.min(...values),
    span = Math.max(...values) - low || 1;
  const first = points[0].t,
    range = points.at(-1).t - first || 1;
  const path = points
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${(3 + ((p.t - first) / range) * 96).toFixed(1)},${(29 - ((p.v - low) / span) * 25).toFixed(1)}`,
    )
    .join(" ");
  return `<svg class="sparkline" viewBox="0 0 104 34" aria-hidden="true"><path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function lineChart(host, series, options = {}) {
  const all = series
    .flatMap((s) =>
      s.points.map((p) => ({ ...p, series: s.label, color: colorOf(s) })),
    )
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t);
  if (!all.length) {
    host.innerHTML =
      '<div class="chart-empty">No measurements in this period.<br><span>Try a wider date range or another source.</span></div>';
    return () => {};
  }
  const xFormat = options.xFormat || formatDay;
  const unit = options.unit || "";
  const render = () => {
    const width = Math.max(290, Math.round(host.clientWidth || 600)),
      height = options.height || 230;
    const pad = { left: 48, right: 14, top: 20, bottom: 30 };
    let xmin = options.start ?? Math.min(...all.map((p) => p.t)),
      xmax = options.end ?? Math.max(...all.map((p) => p.t));
    if (xmin === xmax) {
      xmin -= options.time === false ? 1 : DAY;
      xmax += options.time === false ? 1 : DAY;
    }
    const band = options.band || [];
    const values = [
      ...all.map((p) => p.v),
      ...band.flatMap((p) => [p.low, p.high]),
      ...(options.reference || []),
    ].filter(Number.isFinite);
    let min = Math.min(...values),
      max = Math.max(...values),
      span = max - min || Math.max(1, Math.abs(max) * 0.05);
    min -= span * 0.13;
    max += span * 0.13;
    if (options.floor !== undefined) min = Math.max(options.floor, min);
    if (min === max) max = min + 1;
    const x = (t) =>
      pad.left + ((t - xmin) / (xmax - xmin)) * (width - pad.left - pad.right);
    const y = (v) =>
      pad.top + ((max - v) / (max - min)) * (height - pad.top - pad.bottom);
    let svg = `<svg viewBox="0 0 ${width} ${height}" class="plot" role="img" aria-label="${escapeHtml(options.title || "Measurement history")}. ${escapeHtml(unit)}. ${all.length} plotted values.">`;
    for (let i = 0; i < 4; i++) {
      const v = min + ((max - min) * i) / 3;
      svg += `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}" class="grid-line"/><text x="${pad.left - 9}" y="${y(v) + 4}" text-anchor="end">${formatNumber(v, Math.abs(v) > 100 ? 0 : 1)}</text>`;
    }
    const ticks = width < 450 ? 3 : 5;
    for (let i = 0; i < ticks; i++) {
      const t = xmin + ((xmax - xmin) * i) / (ticks - 1);
      svg += `<text x="${x(t)}" y="${height - 6}" text-anchor="${i === 0 ? "start" : i === ticks - 1 ? "end" : "middle"}">${escapeHtml(xFormat(t))}</text>`;
    }
    if (options.reference?.length === 2) {
      const [lo, hi] = options.reference;
      svg += `<rect x="${pad.left}" y="${y(hi)}" width="${width - pad.left - pad.right}" height="${y(lo) - y(hi)}" class="reference-band"/>`;
    }
    if (band.length) {
      svg += `<path d="${band.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.high)}`).join(" ")} ${[
        ...band,
      ]
        .reverse()
        .map((p) => `L${x(p.t)},${y(p.low)}`)
        .join(
          " ",
        )} Z" fill="${options.bandColor || "#3185d6"}" opacity=".13"/>`;
    }
    for (const s of series) {
      let previous = null;
      let path = "";
      for (const p of s.points) {
        const gap = previous && p.t - previous.t > (options.maxGap ?? 45 * DAY);
        path += `${!previous || gap ? "M" : "L"}${x(p.t)},${y(p.v)} `;
        previous = p;
      }
      svg += `<path d="${path}" fill="none" stroke="${colorOf(s)}" stroke-width="${s.width || 2.25}" stroke-linecap="round" stroke-linejoin="round" ${s.dashed ? 'stroke-dasharray="5 5"' : ""} opacity="${s.opacity ?? 1}"/>`;
      if (s.dots !== false && s.points.length <= 150)
        for (const p of s.points) {
          svg +=
            s.key === "accuniq_report"
              ? `<path d="M${x(p.t)},${y(p.v) - 4}l4,4 -4,4 -4,-4Z" fill="${colorOf(s)}"/>`
              : `<circle cx="${x(p.t)}" cy="${y(p.v)}" r="2.8" fill="${colorOf(s)}"/>`;
        }
    }
    svg +=
      '<line class="chart-cursor" hidden/><circle class="chart-cursor-dot" r="5" hidden/></svg>';
    host.innerHTML = `${svg}<div class="chart-reading"><output aria-live="polite">Touch the chart to inspect a reading</output>${options.onSelect ? '<button class="text-button chart-open" type="button" hidden>View record <span aria-hidden="true">›</span></button>' : ""}</div><input class="chart-scrubber" type="range" min="0" max="${all.length - 1}" step="1" value="${all.length - 1}" aria-label="Inspect chart readings"/>`;
    let selected = null;
    const choose = (index) => {
      selected = all[index];
      if (!selected) return;
      const cursor = host.querySelector(".chart-cursor");
      cursor.removeAttribute("hidden");
      for (const [k, v] of Object.entries({
        x1: x(selected.t),
        x2: x(selected.t),
        y1: pad.top,
        y2: height - pad.bottom,
      }))
        cursor.setAttribute(k, v);
      const dot = host.querySelector(".chart-cursor-dot");
      dot.removeAttribute("hidden");
      dot.setAttribute("cx", x(selected.t));
      dot.setAttribute("cy", y(selected.v));
      dot.setAttribute("fill", selected.color);
      const wording = `${xFormat(selected.t)} · ${formatNumber(selected.v)} ${unit} · ${selected.series}`;
      host.querySelector("output").textContent = wording;
      const slider = host.querySelector("input");
      slider.value = index;
      slider.setAttribute("aria-valuetext", wording);
      const open = host.querySelector(".chart-open");
      if (open) open.hidden = !selected.log;
    };
    host
      .querySelector("input")
      .addEventListener("input", (e) => choose(Number(e.target.value)));
    host
      .querySelector(".chart-open")
      ?.addEventListener(
        "click",
        () => selected?.log && options.onSelect(selected.log),
      );
    const plot = host.querySelector("svg");
    const inspect = (e) => {
      const rect = plot.getBoundingClientRect(),
        px = ((e.clientX - rect.left) / rect.width) * width,
        py = ((e.clientY - rect.top) / rect.height) * height;
      let best = 0,
        dist = Infinity;
      for (let i = 0; i < all.length; i++) {
        const d = Math.abs(x(all[i].t) - px) * 4 + Math.abs(y(all[i].v) - py);
        if (d < dist) {
          dist = d;
          best = i;
        }
      }
      choose(best);
    };
    let dragging = false;
    plot.addEventListener("pointerdown", (e) => {
      dragging = true;
      inspect(e);
      plot.setPointerCapture?.(e.pointerId);
    });
    plot.addEventListener("pointermove", (e) => {
      if (dragging || e.pointerType === "mouse") inspect(e);
    });
    plot.addEventListener("pointerup", () => {
      dragging = false;
    });
    plot.addEventListener("pointercancel", () => {
      dragging = false;
    });
    choose(all.length - 1);
  };
  render();
  let lastWidth = host.clientWidth;
  const observer =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (
            host.clientWidth > 0 &&
            Math.abs(lastWidth - host.clientWidth) > 1
          ) {
            lastWidth = host.clientWidth;
            render();
          }
        });
  observer?.observe(host);
  return () => observer?.disconnect();
}

export function barChart(
  host,
  buckets,
  { field = "minutes", unit = "min", color = "#bc517b", onSelect } = {},
) {
  const max = Math.max(1, ...buckets.map((b) => b[field]));
  host.innerHTML = `<div class="bar-plot" role="group" aria-label="Recorded training by week">${buckets.map((b, i) => `<button type="button" data-index="${i}" class="bar-column" aria-label="${escapeHtml(formatDay(b.t))}: ${formatNumber(b[field], 0)} ${unit}, ${b.count} sessions"><span class="bar-shape" style="height:${Math.max(1, (b[field] / max) * 100)}%;background:${color};opacity:${b.count ? 1 : 0.12}"></span><span class="bar-label">${i % Math.ceil(buckets.length / 5) === 0 ? escapeHtml(formatDay(b.t)) : ""}</span></button>`).join("")}</div><output class="bar-reading" aria-live="polite">Select a week to see its sessions.</output>`;
  for (const button of host.querySelectorAll("button"))
    button.addEventListener("click", () => {
      const b = buckets[Number(button.dataset.index)];
      host.querySelector("output").textContent =
        `${formatDay(b.t)}–${formatDay(b.end)} · ${formatNumber(b[field], 0)} ${unit} · ${b.count} sessions`;
      onSelect?.(b);
    });
}

export function scatterChart(
  host,
  pairs,
  { xLabel, yLabel, color = "#3185d6", onSelect } = {},
) {
  if (!pairs.length) {
    host.innerHTML =
      '<div class="chart-empty">No paired measurements in this period.</div>';
    return;
  }
  const width = Math.max(290, host.clientWidth || 600),
    height = 250,
    pad = { left: 48, right: 20, top: 20, bottom: 45 };
  const xs = pairs.map((p) => p.x),
    ys = pairs.map((p) => p.y);
  let xmin = Math.min(...xs),
    xmax = Math.max(...xs),
    ymin = Math.min(...ys),
    ymax = Math.max(...ys);
  const xp = (xmax - xmin || 1) * 0.1,
    yp = (ymax - ymin || 1) * 0.1;
  xmin -= xp;
  xmax += xp;
  ymin -= yp;
  ymax += yp;
  const x = (v) =>
      pad.left + ((v - xmin) / (xmax - xmin)) * (width - pad.left - pad.right),
    y = (v) =>
      pad.top + ((ymax - v) / (ymax - ymin)) * (height - pad.top - pad.bottom);
  let markup = `<svg class="plot scatter-plot" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(yLabel)} versus ${escapeHtml(xLabel)}">`;
  for (let i = 0; i < 4; i++) {
    const v = ymin + ((ymax - ymin) * i) / 3;
    markup += `<line x1="${pad.left}" x2="${width - pad.right}" y1="${y(v)}" y2="${y(v)}" class="grid-line"/><text x="${pad.left - 8}" y="${y(v) + 4}" text-anchor="end">${formatNumber(v)}</text>`;
  }
  for (let i = 0; i < 3; i++) {
    const v = xmin + ((xmax - xmin) * i) / 2;
    markup += `<text x="${x(v)}" y="${height - 20}" text-anchor="middle">${formatNumber(v)}</text>`;
  }
  for (const p of pairs)
    markup += `<circle cx="${x(p.x)}" cy="${y(p.y)}" r="5" fill="${color}" opacity=".8"/>`;
  host.innerHTML =
    markup +
    `</svg><p class="axis-caption">${escapeHtml(xLabel)} →</p><div class="chart-reading"><output aria-live="polite">Select a point to inspect it.</output><button class="text-button" type="button" hidden>View record ›</button></div>`;
  let selected;
  host.querySelector("svg").addEventListener("click", (e) => {
    const rect = e.currentTarget.getBoundingClientRect(),
      px = ((e.clientX - rect.left) / rect.width) * width,
      py = ((e.clientY - rect.top) / rect.height) * height;
    selected = [...pairs].sort(
      (a, b) =>
        Math.hypot(x(a.x) - px, y(a.y) - py) -
        Math.hypot(x(b.x) - px, y(b.y) - py),
    )[0];
    host.querySelector("output").textContent =
      `${formatDay(selected.t)} · ${formatNumber(selected.x)} / ${formatNumber(selected.y)}`;
    host.querySelector("button").hidden = false;
  });
  host
    .querySelector("button")
    .addEventListener("click", () => selected && onSelect?.(selected.log));
}
