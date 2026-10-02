import {
  DAY,
  SOURCES,
  TRAINING_CONTEXT,
  numeric,
  humanize,
  logDate,
  dayStamp,
  todayStamp,
  metricValue,
  metricCatalog,
  pointsFor,
  preferredSource,
  latestReference,
  smoothPoints,
  summarise,
  rangeBounds,
  pairedMetrics,
  correlation,
  devicePairs,
  projectTrend,
  compositionScenario,
  workoutBuckets,
  heartRateSeries,
  heartRateDistribution,
  qualitativeHistory,
  recordIssues,
} from "./analytics.js";
import {
  escapeHtml as esc,
  formatNumber as num,
  formatDay as date,
  sparkline,
  lineChart,
  barChart,
  scatterChart,
} from "./charts.js";

const sourceName = (key) =>
  SOURCES[key]?.short || humanize(key || "Unknown source");
const metricName = (spec) =>
  `${spec.label}${spec.unit ? ` (${spec.unit})` : ""}`;
const signed = (n, digits = 1) =>
  `${Math.round(n * 10 ** digits) > 0 ? "+" : ""}${num(n, digits)}`;
const empty = (title, text) =>
  `<div class="empty-state"><h2>${esc(title)}</h2><p>${esc(text)}</p><button type="button" data-go="data">Add data</button></div>`;
const heading = (title, action = "", target = "") =>
  `<div class="section-heading"><h2>${esc(title)}</h2>${action ? `<button type="button" class="text-button" data-go="${target}">${esc(action)} <span aria-hidden="true">›</span></button>` : ""}</div>`;
const legend = (keys) =>
  `<div class="chart-legend">${keys.map((key) => `<span><i class="source-dot ${key === "accuniq_report" ? "diamond" : ""}" style="--source:${SOURCES[key]?.color || "#777"}"></i>${esc(sourceName(key))}</span>`).join("")}</div>`;
const stat = (value, label, unit = "") =>
  `<div class="stat"><strong>${value}<small>${esc(unit)}</small></strong><span>${esc(label)}</span></div>`;
const ranges = (current, kind = "range") =>
  `<div class="segmented range-control" role="group" aria-label="Date range">${["1M", "3M", "6M", "1Y", "All"].map((r) => `<button type="button" data-${kind}="${r}" aria-pressed="${r === current}">${r}</button>`).join("")}</div>`;

export function createVisualiser({ onEditRecord } = {}) {
  const $ = (s) => document.querySelector(s);
  const allowed = ["summary", "body", "training", "explore", "data"];
  const state = {
    page: allowed.includes(location.hash.slice(1))
      ? location.hash.slice(1)
      : "summary",
    range: "6M",
    trainingRange: "3M",
    metric: "fat_percent",
    source: "all",
    bodySource: "accuniq_report",
    bodyId: null,
    summaryMetric: "fat_percent",
    mode: "trend",
    smooth: false,
    reference: false,
    compareMetric: "weight_kg",
    trainingField: "minutes",
    dataTab: "import",
    customStart: "",
    customEnd: "",
    scenarioFat: null,
    scenarioLean: 0,
  };
  let logs = [],
    catalog = [],
    disposers = [],
    dialogDisposers = [];
  const root = () => $(`#${state.page}-content`);
  const specFor = (key) => catalog.find((m) => m.key === key) || catalog[0];
  const bounds = () =>
    state.customStart && state.customEnd
      ? { start: dayStamp(state.customStart), end: dayStamp(state.customEnd) }
      : rangeBounds(state.range, logs);
  const bodies = () =>
    logs
      .filter((l) => l.kind === "body_composition")
      .sort((a, b) => logDate(a).localeCompare(logDate(b)));
  const workouts = () =>
    logs
      .filter((l) => l.kind === "workout")
      .sort((a, b) => logDate(b).localeCompare(logDate(a)));
  const draw = (...args) => disposers.push(lineChart(...args));

  function navigate(page, { scroll = true } = {}) {
    if (!allowed.includes(page)) return;
    state.page = page;
    history.replaceState(null, "", `#${page}`);
    for (const el of document.querySelectorAll("[data-page-panel]"))
      el.hidden = el.dataset.pagePanel !== page;
    for (const button of document.querySelectorAll(
      ".primary-nav [data-page]",
    )) {
      if (button.dataset.page === page)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    const titles = {
      summary: "Summary",
      body: "Body",
      training: "Training",
      explore: "Explore",
      data: "Your data",
    };
    $("#page-title").textContent = titles[page];
    $("#page-subtitle").textContent = {
      summary: "Your measurements, in perspective.",
      body: "Composition, context, and change.",
      training: "A closer look at the work you put in.",
      explore: "Follow a trend. Find a relationship.",
      data: "Import, review, and manage your records.",
    }[page];
    render();
    if (scroll) window.scrollTo({ top: 0, behavior: "instant" });
  }
  function metricRows(specs, source, at = Infinity) {
    return `<div class="metric-list">${specs
      .map((spec) => {
        const ps = pointsFor(logs, spec, { source, end: at }),
          last = ps.at(-1);
        if (!last) return "";
        const change = ps.length > 1 ? last.v - ps.at(-2).v : null;
        return `<button type="button" class="metric-row" data-metric="${esc(spec.key)}" data-source="${esc(source)}"><span class="metric-label">${esc(spec.label)}<small>${date(last.t)}${change !== null ? ` · ${signed(change)} ${esc(spec.unit === "%" ? "pp" : spec.unit)} from previous` : ""}</small></span>${sparkline(ps.slice(-12), SOURCES[source]?.color)}<span class="metric-value">${num(last.v)}<small>${esc(spec.unit)}</small></span><span class="chevron" aria-hidden="true">›</span></button>`;
      })
      .join("")}</div>`;
  }
  function recordRows(records, limit = 8) {
    return `<div class="record-list">${
      records
        .slice(0, limit)
        .map((log) => {
          const body = log.kind === "body_composition",
            title = body ? sourceName(log.source?.type) : "Strength training";
          const subtitle = body
            ? `${num(log.metrics?.weight_kg)} kg · ${num(log.metrics?.fat_percent)}% body fat`
            : `${num(log.duration_minutes, 0)} min · ${num(log.active_energy_kcal, 0)} kcal`;
          return `<button type="button" class="record-row" data-record="${esc(log.id)}"><span class="record-symbol ${body ? "body-symbol" : "training-symbol"}" aria-hidden="true">${body ? "◈" : "↗"}</span><span><strong>${esc(title)}</strong><small>${esc(subtitle)}</small></span><span class="record-date">${date(dayStamp(logDate(log)))}<span class="chevron" aria-hidden="true">›</span></span></button>`;
        })
        .join("") ||
      '<p class="inline-empty">No recorded sessions in this period.</p>'
    }</div>`;
  }
  function summary() {
    if (!logs.length) {
      root().innerHTML = empty(
        "Start with your first measurement",
        "Add a body report or an Apple Health export to see your history take shape.",
      );
      return;
    }
    const spec = specFor(state.summaryMetric),
      ref = spec ? latestReference(logs, spec) : null;
    const bodySpecs = catalog.filter((m) => m.kind === "body_composition");
    const bodyMain =
      bodySpecs.find((m) => m.key === state.summaryMetric) || bodySpecs[0];
    const lastBody = bodyMain ? latestReference(logs, bodyMain) : null;
    const range = rangeBounds("6M", logs),
      points = bodyMain ? pointsFor(logs, bodyMain, range) : [];
    const sources = [...new Set(points.map((p) => p.source))];
    const now = todayStamp(),
      training = workoutBuckets(logs, { start: now - 27 * DAY, end: now }, 7);
    const sessions = training.reduce((n, b) => n + b.count, 0),
      minutes = training.reduce((n, b) => n + b.minutes, 0),
      energy = training.reduce((n, b) => n + b.energy, 0);
    const recent = [...logs]
      .sort((a, b) => logDate(b).localeCompare(logDate(a)))
      .slice(0, 5);
    const latestDate = Math.max(
      ...logs.map((l) => dayStamp(logDate(l))).filter(Number.isFinite),
    );
    const daysOld = Math.round((now - latestDate) / DAY);
    root().innerHTML = `<div class="summary-grid">
      <section class="panel summary-body">${heading("Body composition", "Details", "body")}
        ${
          bodyMain
            ? `<div class="metric-switch" role="group" aria-label="Summary metric">${[
                "fat_percent",
                "weight_kg",
                "muscle_mass_kg",
              ]
                .filter((k) => catalog.some((m) => m.key === k))
                .map(
                  (k) =>
                    `<button type="button" data-summary-metric="${k}" aria-pressed="${bodyMain.key === k}">${esc(specFor(k).label)}</button>`,
                )
                .join("")}</div>
        <div class="hero-reading"><strong>${num(lastBody?.v)}<small>${esc(bodyMain.unit)}</small></strong><span>${esc(sourceName(lastBody?.source))} reference · ${date(lastBody?.t, true)}</span></div><div id="summary-chart" class="chart-host"></div>${legend(sources)}<p class="chart-note">Last 6 months · separate device histories</p>`
            : "<p>Add a body report to see composition trends.</p>"
        }
      </section>
      <section class="panel summary-training">${heading("Training", "Details", "training")}<p class="overline">Last 28 days · recorded sessions</p><div class="stats-row">${stat(num(sessions, 0), "Sessions")}${stat(num(minutes / 60), "Time", "hr")}${stat(energy ? num(energy, 0) : "—", "Active energy", "kcal")}</div><div id="summary-training-chart"></div><p class="chart-note">${date(now - 27 * DAY)}–${date(now)} · strength training</p></section>
      <section class="panel summary-reference">${heading("Your reference", "All measurements", "body")}${metricRows(
        catalog.filter((s) =>
          [
            "weight_kg",
            "fat_percent",
            "fat_mass_kg",
            "muscle_mass_kg",
          ].includes(s.key),
        ),
        lastBody?.source || "accuniq_report",
      )}
        <p class="panel-note">ACCUNIQ is preferred where available. Each value keeps its measurement date.</p></section>
      <section class="panel summary-recent">${heading("Recent records", "See all", "data")}${recordRows(recent, 5)}</section>
    </div><div class="quiet-summary"><span>${bodies().length} body reports · ${workouts().length} workouts</span><span>Latest record ${date(latestDate, true)}${daysOld > 7 ? ` · ${daysOld} days ago` : ""}</span></div>`;
    if (points.length)
      draw(
        $("#summary-chart"),
        sources.map((s) => ({
          key: s,
          label: sourceName(s),
          points: points.filter((p) => p.source === s),
        })),
        {
          unit: bodyMain.unit,
          title: bodyMain.label,
          ...range,
          onSelect: openRecord,
        },
      );
    barChart($("#summary-training-chart"), training, {
      onSelect: () => navigate("training"),
    });
  }
  function body() {
    const all = bodies();
    if (!all.length) {
      root().innerHTML = empty(
        "Body composition",
        "Import a TANITA receipt or an ACCUNIQ report.",
      );
      return;
    }
    const sources = [...new Set(all.map((l) => l.source.type))];
    if (!sources.includes(state.bodySource))
      state.bodySource = preferredSource(
        all.map((l) => ({ source: l.source.type })),
      );
    const records = all.filter((l) => l.source.type === state.bodySource),
      log = records.find((l) => l.id === state.bodyId) || records.at(-1);
    const m = log.metrics || {},
      fat = numeric(m.fat_mass_kg)
        ? m.fat_mass_kg
        : numeric(m.weight_kg) && numeric(m.fat_percent)
          ? (m.weight_kg * m.fat_percent) / 100
          : null;
    const lean = numeric(m.ffm_kg)
      ? m.ffm_kg
      : fat !== null && numeric(m.weight_kg)
        ? m.weight_kg - fat
        : null;
    const valid =
      numeric(fat) && numeric(lean) && fat >= 0 && lean >= 0 && fat + lean > 0;
    const fatShare = valid ? (fat / (fat + lean)) * 100 : 0;
    const groups = [
      ...new Set(
        catalog
          .filter((s) => s.kind === "body_composition")
          .map((s) => s.group),
      ),
    ];
    const words = Object.entries(log.qualitative || {}).filter(
      ([, v]) => typeof v === "string" && v.trim(),
    );
    root().innerHTML = `<div class="body-controls"><div class="segmented" role="group" aria-label="Body measurement device">${sources.map((s) => `<button type="button" data-body-source="${esc(s)}" aria-pressed="${state.bodySource === s}">${esc(sourceName(s))}</button>`).join("")}</div><label class="select-label"><span>Measurement</span><select id="body-snapshot">${[
      ...records,
    ]
      .reverse()
      .map(
        (l) =>
          `<option value="${esc(l.id)}" ${l.id === log.id ? "selected" : ""}>${date(dayStamp(logDate(l)), true)}</option>`,
      )
      .join("")}</select></label></div>
      <div class="body-grid"><section class="panel composition-panel">${heading("Composition")}<p class="overline">${esc(SOURCES[state.bodySource]?.method || "")} · ${date(dayStamp(logDate(log)), true)}</p><div class="hero-reading"><strong>${num(m.weight_kg)}<small>kg</small></strong><span>Total weight</span></div>
        ${valid ? `<div class="composition-bar" role="img" aria-label="Fat ${num(fat)} kg; fat-free mass ${num(lean)} kg"><span style="width:${fatShare}%;background:var(--body-color)"></span><span style="width:${100 - fatShare}%;background:var(--lean-color)"></span></div><div class="composition-key"><div><i style="background:var(--body-color)"></i><span>Fat<strong>${num(fat)} <small>kg</small></strong></span></div><div><i style="background:var(--lean-color)"></i><span>Fat-free mass<strong>${num(lean)} <small>kg</small></strong></span></div></div>` : "<p>Fat and fat-free mass are not both available in this report.</p>"}
        <p class="panel-note">Muscle and body water are included within fat-free mass; they are not additional parts of total weight.</p><button type="button" class="text-button" data-record="${esc(log.id)}">View full measurement ›</button></section>
      <section class="panel reported-panel">${heading("As reported")}${words.length ? words.map(([key, value]) => `<div class="reported-word"><span>${esc(humanize(key))}</span><p>${esc(value)}</p></div>`).join("") : "<p>No classification text in this report.</p>"}<p class="panel-note">Original wording from the device. Labels are preserved without assigning a score.</p><details><summary>Classification history</summary><div class="word-history">${qualitativeHistory(
        records,
      )
        .filter((r) => r.key !== "evaluation")
        .map(
          (r) =>
            `<button type="button" data-record="${esc(r.log.id)}"><span>${date(dayStamp(logDate(r.log)), true)}</span><strong>${esc(r.value)}</strong></button>`,
        )
        .join("")}</div></details></section></div>
      <div class="metric-groups">${groups
        .map((group) => {
          const specs = catalog.filter(
            (s) =>
              s.kind === "body_composition" &&
              s.group === group &&
              pointsFor(logs, s, {
                source: state.bodySource,
                end: dayStamp(logDate(log)),
              }).length,
          );
          return specs.length
            ? `<section class="panel">${heading(group)}${metricRows(specs, state.bodySource, dayStamp(logDate(log)))}</section>`
            : "";
        })
        .join("")}</div>
      <section class="panel">${heading("Understanding your devices")}<div class="source-explanation"><div><h3>ACCUNIQ <span>Hands + feet</span></h3><p>Preferred composition reference. Its measurements include paths through the upper and lower body.</p></div><div><h3>TANITA <span>Feet only</span></h3><p>Useful for frequent, consistent tracking. Compare its readings with its own history.</p></div></div><p class="panel-note">Both estimate composition using impedance. Hydration, food and recent exercise can shift readings. More electrodes do not establish an exact accuracy percentage.</p>
      <details><summary>Nearby device comparisons</summary><p class="panel-note">TANITA minus ACCUNIQ, paired within 3 calendar days. These differences include timing and measurement conditions; they are not used as correction factors.</p><div class="compact-table-wrap"><table class="compact-table"><thead><tr><th>Metric</th><th>Median difference</th><th>Pairs</th></tr></thead><tbody>${catalog
        .filter((s) =>
          [
            "weight_kg",
            "fat_percent",
            "fat_mass_kg",
            "muscle_mass_kg",
          ].includes(s.key),
        )
        .map((s) => {
          const d = devicePairs(logs, s);
          return `<tr><td>${esc(s.label)}</td><td>${d.pairs.length ? signed(d.medianDifference) : "—"} ${esc(s.unit === "%" ? "pp" : s.unit)}</td><td>${d.pairs.length}</td></tr>`;
        })
        .join("")}</tbody></table></div></details></section>`;
    $("#body-snapshot").addEventListener("change", (e) => {
      state.bodyId = e.target.value;
      render();
    });
  }
  function training() {
    const all = workouts();
    if (!all.length) {
      root().innerHTML = empty(
        "Your training history",
        "Import an Apple Health export to explore strength workouts and heart rate.",
      );
      return;
    }
    const range = rangeBounds(state.trainingRange, logs),
      selected = all.filter(
        (l) =>
          dayStamp(logDate(l)) >= range.start &&
          dayStamp(logDate(l)) <= range.end,
      );
    const buckets = workoutBuckets(
      selected,
      range,
      state.trainingRange === "1Y" || state.trainingRange === "All" ? 28 : 7,
    );
    const minutes = selected.reduce((n, l) => n + (l.duration_minutes || 0), 0),
      energy = selected.filter((l) => numeric(l.active_energy_kcal));
    const days = new Map();
    for (const l of selected) {
      const k = dayStamp(logDate(l));
      if (!days.has(k)) days.set(k, []);
      days.get(k).push(l);
    }
    const heatStart = Math.max(range.start, range.end - 90 * DAY),
      heatDays = [];
    for (let t = heatStart; t <= range.end; t += DAY) heatDays.push(t);
    root().innerHTML = `${ranges(state.trainingRange, "training-range")}<div class="training-grid"><section class="panel">${heading("Recorded training")}<p class="overline">${date(range.start)}–${date(range.end, true)}</p><div class="stats-row">${stat(num(selected.length, 0), "Sessions")}${stat(num(minutes / 60), "Duration", "hr")}${stat(
      energy.length
        ? num(
            energy.reduce((n, l) => n + l.active_energy_kcal, 0),
            0,
          )
        : "—",
      "Active energy",
      "kcal",
    )}</div><p class="panel-note">Strength sessions only. Active energy is the recorded estimate; session time does not measure lifting volume.</p></section>
      <section class="panel">${heading("Consistency")}<p class="overline">${date(heatStart)}–${date(range.end)} · each square is a day</p><div class="heatmap">${heatDays
        .map((t) => {
          const a = days.get(t) || [];
          return a.length
            ? `<button type="button" data-training-day="${t}" style="--intensity:${Math.min(1, 0.4 + a.reduce((n, l) => n + (l.duration_minutes || 0), 0) / 120)}" aria-label="${date(t, true)}: ${a.length} sessions, ${num(
                a.reduce((n, l) => n + (l.duration_minutes || 0), 0),
                0,
              )} minutes"></button>`
            : `<span title="${date(t)}: no recorded workout" aria-hidden="true"></span>`;
        })
        .join(
          "",
        )}</div><div class="heatmap-key"><span>No recorded session</span><span>Less <i></i><i></i><i></i> More time</span></div></section>
      <section class="panel training-volume">${heading(buckets.length && buckets[0].end - buckets[0].t > 7 * DAY ? "28-day totals" : "7-day totals")}<div class="metric-switch" role="group" aria-label="Training chart metric">${[
        ["minutes", "Time"],
        ["count", "Sessions"],
        ["energy", "Energy"],
      ]
        .map(
          ([k, v]) =>
            `<button type="button" data-training-field="${k}" aria-pressed="${state.trainingField === k}">${v}</button>`,
        )
        .join(
          "",
        )}</div><div id="training-bars"></div><p class="panel-note">Empty bars mean no imported sessions. The last interval may be incomplete.</p><div id="training-selection"></div></section>
      <section class="panel training-sessions">${heading("Sessions")}<p class="overline">${selected.length} in this period</p>${recordRows(selected, 100)}</section></div>`;
    barChart($("#training-bars"), buckets, {
      field: state.trainingField,
      unit: { minutes: "min", energy: "kcal", count: "sessions" }[
        state.trainingField
      ],
      onSelect: (b) => {
        $("#training-selection").innerHTML =
          `<h3>${date(b.t)}–${date(b.end)}</h3>${recordRows(b.logs, 100)}`;
      },
    });
    for (const b of root().querySelectorAll("[data-training-day]"))
      b.addEventListener("click", () => {
        const records = days.get(Number(b.dataset.trainingDay));
        if (records.length === 1) openRecord(records[0]);
        else {
          $("#training-selection").innerHTML = recordRows(records);
          $("#training-selection").scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
        }
      });
  }
  function sourceControl(spec, onlyOne = false) {
    const ps = pointsFor(logs, spec),
      sources = [...new Set(ps.map((p) => p.source))];
    if (onlyOne && (state.source === "all" || !sources.includes(state.source)))
      state.source = preferredSource(ps);
    return `<div class="segmented source-control" role="group" aria-label="Data source">${(!onlyOne && sources.length > 1 ? ["all", ...sources] : sources).map((s) => `<button type="button" data-explore-source="${esc(s)}" aria-pressed="${state.source === s || (state.source === "all" && sources.length === 1)}">${s === "all" ? "Both devices" : esc(sourceName(s))}</button>`).join("")}</div>`;
  }
  function explore() {
    if (!catalog.length) {
      root().innerHTML = empty(
        "Explore your data",
        "Add measurements to inspect trends, compare metrics, and model possible changes.",
      );
      return;
    }
    const projectable = [
      "weight_kg",
      "fat_percent",
      "fat_mass_kg",
      "ffm_kg",
      "muscle_mass_kg",
    ];
    const choices =
      state.mode === "model"
        ? catalog.filter((s) => projectable.includes(s.key))
        : catalog;
    if (!choices.length) {
      root().innerHTML = empty(
        "Composition models",
        "A body report is needed to model composition.",
      );
      return;
    }
    if (!choices.some((m) => m.key === state.metric))
      state.metric = choices[0].key;
    const spec = specFor(state.metric);
    const groups = [...new Set(choices.map((s) => s.group))];
    const control = sourceControl(spec, state.mode !== "trend");
    root().innerHTML = `<div class="segmented explore-mode" role="group" aria-label="Analysis view">${[
      ["trend", "Trends"],
      ["compare", "Compare"],
      ["model", "Models"],
    ]
      .map(
        ([k, v]) =>
          `<button type="button" data-mode="${k}" aria-pressed="${state.mode === k}">${v}</button>`,
      )
      .join(
        "",
      )}</div><div class="explore-controls"><label class="select-label"><span>Metric</span><select id="explore-metric">${groups
      .map(
        (group) =>
          `<optgroup label="${esc(group)}">${choices
            .filter((s) => s.group === group)
            .map(
              (s) =>
                `<option value="${esc(s.key)}" ${s.key === spec.key ? "selected" : ""}>${esc(metricName(s))}</option>`,
            )
            .join("")}</optgroup>`,
      )
      .join("")}</select></label>${control}</div>
      ${state.mode !== "model" ? `${ranges(state.customStart ? "Custom" : state.range)}<details class="custom-dates"><summary>Custom dates${state.customStart ? ` · ${esc(state.customStart)} to ${esc(state.customEnd)}` : ""}</summary><form id="custom-range-form"><label>From<input type="date" id="range-from" value="${esc(state.customStart)}" required></label><label>To<input type="date" id="range-to" value="${esc(state.customEnd)}" required></label><button type="submit" class="secondary">Apply</button><span id="range-error" role="status"></span></form></details>` : ""}<div id="explore-view"></div>`;
    $("#explore-metric").addEventListener("change", (e) => {
      state.metric = e.target.value;
      state.source = "all";
      render();
    });
    $("#custom-range-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      const a = $("#range-from").value,
        b = $("#range-to").value;
      if (
        !Number.isFinite(dayStamp(a)) ||
        !Number.isFinite(dayStamp(b)) ||
        a > b
      ) {
        $("#range-error").textContent =
          "Choose an end date on or after the start date.";
        return;
      }
      state.customStart = a;
      state.customEnd = b;
      render();
    });
    if (state.mode === "trend") trendView(spec);
    else if (state.mode === "compare") compareView(spec);
    else modelView(spec);
  }
  function trendView(spec) {
    const range = bounds(),
      points = pointsFor(logs, spec, { ...range, source: state.source }),
      sources = [...new Set(points.map((p) => p.source))];
    const preferred =
        state.source === "all" ? preferredSource(points) : state.source,
      refPoints = points.filter((p) => p.source === preferred),
      stats = summarise(refPoints);
    const rr = refPoints.at(-1)?.log.reference_ranges?.[spec.key],
      reference =
        state.reference &&
        sources.length === 1 &&
        numeric(rr?.min) &&
        numeric(rr?.max) &&
        rr.min <= rr.max
          ? [rr.min, rr.max]
          : null;
    $("#explore-view").innerHTML =
      `<section class="panel trend-panel"><div class="section-heading"><div><p class="overline">${esc(sourceName(preferred))} · latest in period</p><div class="hero-reading"><strong>${stats ? num(stats.latest) : "—"}<small>${esc(spec.unit)}</small></strong></div></div><span class="period-label">${date(range.start)}<br>${date(range.end, true)}</span></div><div id="explore-chart" class="chart-host"></div>${legend(sources)}<div class="chart-options"><label><input type="checkbox" id="smooth-trend" ${state.smooth ? "checked" : ""}> 28-day median</label>${sources.length === 1 && rr ? `<label><input type="checkbox" id="show-reference" ${state.reference ? "checked" : ""}> Report range</label>` : ""}</div>
      <div class="trend-stats">${sources
        .map((s) => {
          const a = points.filter((p) => p.source === s),
            v = summarise(a);
          return `<div><strong>${esc(sourceName(s))}</strong><span>${a.length > 1 ? signed(v.change) : "—"} ${esc(spec.unit === "%" ? "pp" : spec.unit)} <small>first to last</small></span><span>${a.length} <small>readings</small></span><span>${num(v.median)} <small>median ${esc(spec.unit)}</small></span></div>`;
        })
        .join(
          "",
        )}</div><p class="panel-note">${state.smooth ? "The median uses observed days in the preceding 28 days, separately for each device. Raw readings remain visible." : "Drag the chart or its slider to inspect each reading. Device histories are never averaged together."}${reference ? ` Shading: ${num(reference[0])}–${num(reference[1])} ${esc(spec.unit)}, from the latest report in this period.` : ""}${spec.group === "Printed indicators" ? " Indicator positions describe the printed bar, not the physiological measurement itself." : ""}</p></section>
      <section class="panel">${heading("Measurements")}<div class="compact-table-wrap"><table class="compact-table"><thead><tr><th>Date</th><th>Source</th><th>${esc(spec.unit || "Value")}</th><th></th></tr></thead><tbody>${[
        ...points,
      ]
        .reverse()
        .map(
          (p) =>
            `<tr><td>${date(p.t, true)}</td><td>${esc(sourceName(p.source))}</td><td>${num(p.v)}</td><td><button type="button" class="text-button" data-record="${esc(p.log.id)}" aria-label="View ${esc(spec.label)} on ${date(p.t, true)}">View ›</button></td></tr>`,
        )
        .join(
          "",
        )}</tbody></table></div>${!points.length ? '<p class="inline-empty">No measurements match this range and source.</p>' : ""}</section>`;
    const series = sources.flatMap((s) => {
      const p = points.filter((p) => p.source === s);
      return [
        {
          key: s,
          label: sourceName(s) + " · recorded",
          points: p,
          opacity: state.smooth ? 0.4 : 1,
        },
        ...(state.smooth
          ? [
              {
                key: s,
                label: sourceName(s) + " · 28-day median",
                points: smoothPoints(p),
                dots: false,
                width: 2.5,
              },
            ]
          : []),
      ];
    });
    draw($("#explore-chart"), series, {
      unit: spec.unit,
      title: spec.label,
      ...range,
      reference,
      onSelect: openRecord,
    });
    $("#smooth-trend").addEventListener("change", (e) => {
      state.smooth = e.target.checked;
      render();
    });
    $("#show-reference")?.addEventListener("change", (e) => {
      state.reference = e.target.checked;
      render();
    });
  }
  function compareView(spec) {
    const choices = [
      ...catalog.filter((s) => s.kind === spec.kind && s.key !== spec.key),
      ...(spec.kind === "body_composition" && workouts().length
        ? TRAINING_CONTEXT
        : []),
    ];
    if (!choices.length) {
      $("#explore-view").innerHTML =
        '<section class="panel"><p>A second metric is needed for comparison.</p></section>';
      return;
    }
    if (!choices.some((s) => s.key === state.compareMetric))
      state.compareMetric = choices[0].key;
    const second = choices.find((s) => s.key === state.compareMetric),
      pairs = pairedMetrics(logs, spec, second, {
        ...bounds(),
        source: state.source,
      }),
      r = correlation(pairs);
    $("#explore-view").innerHTML =
      `<section class="panel"><label class="select-label"><span>Compare with</span><select id="compare-metric">${choices.map((s) => `<option value="${esc(s.key)}" ${s.key === second.key ? "selected" : ""}>${esc(metricName(s))}</option>`).join("")}</select></label><div class="comparison-summary"><strong>${r === null ? "—" : num(r, 2)}<small>Pearson r</small></strong><span>${pairs.length} paired readings<br>${esc(sourceName(state.source))}</span></div><p class="overline">${esc(metricName(second))} ↑</p><div id="scatter-chart"></div><p class="panel-note">${second.kind === "training_context" ? "Each dot pairs a body measurement with the preceding 28 calendar days of recorded strength sessions. Windows extend only across the imported workout history. Missing sessions may still understate activity." : "Each dot pairs values from the same record."} Correlation describes association, not cause. Composition metrics can also be mathematically related. At least four pairs and nonzero variation are required.</p></section><section class="panel">${heading("Paired readings")}<div class="compact-table-wrap"><table class="compact-table"><thead><tr><th>Date</th><th>${esc(spec.label)}</th><th>${esc(second.label)}</th><th></th></tr></thead><tbody>${[
        ...pairs,
      ]
        .reverse()
        .map(
          (p) =>
            `<tr><td>${date(p.t)}</td><td>${num(p.x)} ${esc(spec.unit)}</td><td>${num(p.y)} ${esc(second.unit)}</td><td><button class="text-button" type="button" data-record="${esc(p.log.id)}">View ›</button></td></tr>`,
        )
        .join("")}</tbody></table></div></section>`;
    scatterChart($("#scatter-chart"), pairs, {
      xLabel: metricName(spec),
      yLabel: metricName(second),
      color: SOURCES[state.source]?.color,
      onSelect: openRecord,
    });
    $("#compare-metric").addEventListener("change", (e) => {
      state.compareMetric = e.target.value;
      render();
    });
  }
  function modelView(spec) {
    const ps = pointsFor(logs, spec, { source: state.source }),
      projection = projectTrend(ps),
      last = ps.at(-1);
    const allBody = bodies().filter((l) => l.source.type === state.source),
      base = allBody.at(-1);
    const scenarioFat = state.scenarioFat ?? base?.metrics?.fat_percent ?? 20;
    const estimate = compositionScenario(base, scenarioFat, state.scenarioLean);
    $("#explore-view").innerHTML =
      `<div class="model-grid"><section class="panel">${heading("If the recent trend continues")}<p class="overline">${esc(sourceName(state.source))} · ${esc(spec.label)}</p>${projection.reason ? `<div class="model-empty"><strong>More history needed</strong><p>${esc(projection.reason)}</p></div>` : `<div class="hero-reading"><strong>${signed(projection.slopePerWeek, 2)}<small>${esc(spec.unit === "%" ? "pp" : spec.unit)}/week</small></strong><span>Fitted change · ${projection.n} measurement days</span></div><div id="projection-chart" class="chart-host"></div><div class="projection-result"><span>28-day extrapolation</span><strong>${num(projection.points.at(-1).v)} ${esc(spec.unit)}</strong><small>${num(projection.points.at(-1).low)}–${num(projection.points.at(-1).high)} ${esc(spec.unit)} prediction interval</small></div>`}
      <details><summary>How this projection works</summary><p>One device, daily medians, and a straight-line fit to the last 90 days. Requires 6 measurement days spanning at least 28 days, a reading within 30 days, and no gap over 45 days.</p><p>The shaded 95% prediction interval describes statistical variability under that model. It does not measure device accuracy or guarantee an outcome. It does not account for future changes in diet, training or hydration.</p></details></section>
      <section class="panel">${heading("Composition scenario")}<p class="overline">Based on ${esc(sourceName(state.source))} · ${base ? date(dayStamp(logDate(base)), true) : "no reading"}</p><p class="panel-note">Explore a possible composition by changing fat percentage and assumed fat-free mass. This is arithmetic, not a forecast or a recommended goal.</p>
      <label class="scenario-control"><span>Body fat <output id="scenario-fat-value">${num(scenarioFat)}%</output></span><input type="range" id="scenario-fat" min="1" max="60" step="0.1" value="${scenarioFat}" aria-label="Scenario body fat percentage"></label>
      <label class="scenario-control"><span>Fat-free mass change <output id="scenario-lean-value">${signed(state.scenarioLean)} kg</output></span><input type="range" id="scenario-lean" min="-5" max="5" step="0.1" value="${state.scenarioLean}" aria-label="Scenario fat-free mass change in kilograms"></label><div id="scenario-result"></div><p class="panel-note">Fat-free mass includes muscle, water and other tissue. No regional body shape is inferred.</p></section></div>`;
    const showScenario = () => {
      const f = Number($("#scenario-fat").value),
        l = Number($("#scenario-lean").value),
        r = compositionScenario(base, f, l);
      state.scenarioFat = f;
      state.scenarioLean = l;
      $("#scenario-fat-value").textContent = `${num(f)}%`;
      $("#scenario-lean-value").textContent = `${signed(l)} kg`;
      $("#scenario-result").innerHTML = r
        ? `<div class="stats-row">${stat(num(r.weight), "Total weight", "kg")}${stat(num(r.fatMass), "Fat mass", "kg")}${stat(num(r.leanMass), "Fat-free mass", "kg")}</div><p class="scenario-change">${r.change === null ? "" : `${signed(r.change)} kg from the reference measurement`}</p>`
        : "<p>Needs weight and either fat or fat-free mass in the selected report.</p>";
    };
    $("#scenario-fat").addEventListener("input", showScenario);
    $("#scenario-lean").addEventListener("input", showScenario);
    showScenario();
    if (!projection.reason)
      draw(
        $("#projection-chart"),
        [
          {
            key: state.source,
            label: "Observed daily median",
            points: projection.history,
          },
          {
            key: state.source,
            label: "Linear projection",
            points: projection.points,
            dashed: true,
            dots: false,
          },
        ],
        {
          title: "Conditional trend projection",
          unit: spec.unit,
          start: todayStamp() - 90 * DAY,
          end: todayStamp() + 28 * DAY,
          band: projection.points,
          bandColor: SOURCES[state.source]?.color,
        },
      );
  }
  function data() {
    for (const section of document.querySelectorAll("[data-data-panel]"))
      section.hidden = section.dataset.dataPanel !== state.dataTab;
    for (const button of document.querySelectorAll("[data-data-tab]"))
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.dataTab === state.dataTab),
      );
    const sourceCounts = Object.entries(SOURCES)
      .map(([key, s]) => {
        const records = logs.filter((l) => l.source?.type === key);
        return `<div><strong>${esc(s.label)}</strong><span>${records.length} records</span><small>${records.length ? `Latest ${date(Math.max(...records.map((l) => dayStamp(logDate(l))).filter(Number.isFinite)), true)}` : "No records yet"}</small></div>`;
      })
      .join("");
    $("#data-source-summary").innerHTML = sourceCounts;
    const issues = logs.flatMap((log) =>
      recordIssues(log).map((message) => ({ log, message })),
    );
    $("#data-quality").innerHTML = issues.length
      ? `<h3>Records to review</h3>${issues.map((x) => `<button type="button" class="quality-row" data-record="${esc(x.log.id)}"><span>${date(dayStamp(logDate(x.log)), true)} · ${esc(sourceName(x.log.source?.type))}</span><strong>${esc(x.message)}</strong></button>`).join("")}`
      : '<p class="panel-note">Basic date and composition checks passed for the saved records. This does not verify OCR accuracy.</p>';
  }
  function openRecord(log) {
    dialogDisposers.splice(0).forEach((fn) => fn());
    const dialog = $("#insight-dialog"),
      host = $("#insight-content");
    $("#insight-title").textContent =
      log.kind === "workout"
        ? "Strength training"
        : sourceName(log.source?.type);
    $("#insight-subtitle").textContent =
      `${date(dayStamp(logDate(log)), true)} · ${logDate(log).slice(11, 16)}`;
    $("#insight-edit").onclick = () => {
      dialog.close();
      onEditRecord?.(log);
    };
    if (!dialog.open) dialog.showModal();
    if (log.kind === "workout") {
      const hr = log.heart_rate_bpm,
        dist = heartRateDistribution(log),
        others = workouts().filter((l) => l.id !== log.id);
      host.innerHTML = `<div class="stats-row">${stat(num(log.duration_minutes, 0), "Duration", "min")}${stat(num(log.active_energy_kcal, 0), "Active energy", "kcal")}${stat(num(hr?.average_bpm, 0), "Average HR", "bpm")}</div><section class="detail-section">${heading("Heart rate")}<p class="overline">${num(hr?.min_bpm, 0)}–${num(hr?.max_bpm, 0)} bpm · ${dist.points.length.toLocaleString()} samples</p><div id="session-chart" class="chart-host"></div><label class="select-label"><span>Compare another session</span><select id="session-compare"><option value="">None</option>${others.map((l) => `<option value="${esc(l.id)}">${date(dayStamp(logDate(l)), true)} · ${num(l.duration_minutes, 0)} min</option>`).join("")}</select></label><div id="session-comparison-note" class="panel-note"></div></section>
      <section class="detail-section">${heading("Observed heart-rate distribution")}<p class="panel-note">${Math.round(dist.coverage * 100)}% of elapsed session covered by consecutive readings. Gaps over 60 seconds are excluded. These are bpm bands, not personalised training zones.</p><div class="hr-bins">${dist.bins.map((b, i) => `<div><span>${b.label} <small>bpm</small></span><i style="--portion:${dist.seconds ? (b.seconds / dist.seconds) * 100 : 0}%;--bin-color:${["#778ba0", "#4c92bb", "#528e78", "#bb854c", "#bf5964"][i]}"></i><strong>${num(b.seconds / 60)} <small>min</small></strong></div>`).join("")}</div></section>`;
      const drawSession = (comparison = null) => {
        dialogDisposers.splice(0).forEach((fn) => fn());
        const series = [
          {
            key: "apple_health_export",
            label: date(dayStamp(logDate(log))),
            points: dist.points,
            dots: false,
          },
          ...(comparison
            ? [
                {
                  key: "accuniq_report",
                  label: date(dayStamp(logDate(comparison))),
                  points: heartRateSeries(comparison),
                  dots: false,
                },
              ]
            : []),
        ];
        dialogDisposers.push(
          lineChart($("#session-chart"), series, {
            title: "Session heart rate",
            unit: "bpm",
            time: false,
            maxGap: 1,
            xFormat: (t) => `${num(t, 0)} min`,
            start: 0,
          }),
        );
        $("#session-comparison-note").textContent = comparison
          ? `Pink: ${date(dayStamp(logDate(log)))}. Blue: ${date(dayStamp(logDate(comparison)))} · ${num(comparison.duration_minutes, 0)} min · ${num(comparison.heart_rate_bpm?.average_bpm, 0)} bpm average. Aligned by elapsed time from session start.`
          : "Time is elapsed from session start. Missing readings appear as gaps.";
      };
      $("#session-compare").addEventListener("change", (e) =>
        drawSession(others.find((l) => l.id === e.target.value)),
      );
      drawSession();
    } else {
      const fields = catalog.filter(
        (s) => s.kind === "body_composition" && metricValue(log, s) !== null,
      );
      const issues = recordIssues(log);
      host.innerHTML = `${issues.map((x) => `<p class="warning">${esc(x)}</p>`).join("")}<dl class="detail-values">${fields.map((s) => `<div><dt>${esc(s.label)}</dt><dd>${num(metricValue(log, s))} <small>${esc(s.unit)}</small></dd></div>`).join("")}</dl>${Object.entries(
        log.qualitative || {},
      )
        .map(
          ([k, v]) =>
            `<div class="reported-word"><span>${esc(humanize(k))}</span><p>${esc(v)}</p></div>`,
        )
        .join(
          "",
        )}<details><summary>Report context</summary><dl class="detail-values">${Object.entries(
        log.input || {},
      )
        .filter(([, v]) => v !== null)
        .map(
          ([k, v]) =>
            `<div><dt>${esc(humanize(k))}</dt><dd>${esc(v)}</dd></div>`,
        )
        .join("")}</dl>${Object.entries(log.indicators || {})
        .map(
          ([k, v]) =>
            `<p>${esc(humanize(k))}: <strong>${esc(v.reading || "No reading")}</strong></p>`,
        )
        .join(
          "",
        )}<p class="panel-note">${esc(log.source?.filename || "")}</p></details>`;
    }
  }
  function render() {
    disposers.splice(0).forEach((fn) => fn());
    ({ summary, body, training, explore, data })[state.page]();
  }
  $("#insight-close").addEventListener("click", () =>
    $("#insight-dialog").close(),
  );
  $("#insight-dialog").addEventListener("close", () =>
    dialogDisposers.splice(0).forEach((fn) => fn()),
  );
  document.addEventListener("click", (event) => {
    const el = event.target.closest("button");
    if (!el) return;
    const d = el.dataset;
    if (d.page || d.go) {
      if (d.go === "data" && el.textContent.includes("See all"))
        state.dataTab = "records";
      navigate(d.page || d.go);
    } else if (d.metric) {
      state.metric = d.metric;
      state.source = d.source || "all";
      state.mode = "trend";
      navigate("explore");
    } else if (d.record) {
      const log = logs.find((l) => l.id === d.record);
      if (log) openRecord(log);
    } else if (d.summaryMetric) {
      state.summaryMetric = d.summaryMetric;
      render();
    } else if (d.bodySource) {
      state.bodySource = d.bodySource;
      state.bodyId = null;
      render();
    } else if (d.range) {
      state.range = d.range;
      state.customStart = "";
      state.customEnd = "";
      render();
    } else if (d.trainingRange) {
      state.trainingRange = d.trainingRange;
      render();
    } else if (d.trainingField) {
      state.trainingField = d.trainingField;
      render();
    } else if (d.exploreSource) {
      state.source = d.exploreSource;
      render();
    } else if (d.mode) {
      state.mode = d.mode;
      render();
    } else if (d.dataTab) {
      state.dataTab = d.dataTab;
      data();
    }
  });
  window.addEventListener("hashchange", () => navigate(location.hash.slice(1)));
  navigate(state.page, { scroll: false });
  return {
    update(next) {
      logs = next;
      catalog = metricCatalog(logs);
      render();
    },
    navigate,
  };
}
