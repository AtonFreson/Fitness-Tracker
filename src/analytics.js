export const DAY = 86_400_000;
export const SOURCES = {
  accuniq_report: {
    label: "ACCUNIQ",
    short: "ACCUNIQ",
    color: "#3185d6",
    method: "Hands + feet",
    reference: true,
  },
  tanita_receipt: {
    label: "TANITA DC-360",
    short: "TANITA",
    color: "#d87838",
    method: "Feet only",
  },
  apple_health_export: {
    label: "Apple Health",
    short: "Apple Health",
    color: "#bc517b",
    method: "Recorded workouts",
  },
};
const specs = [
  ["weight_kg", "Weight", "kg", "Composition"],
  ["fat_percent", "Body fat", "%", "Composition"],
  ["fat_mass_kg", "Fat mass", "kg", "Composition"],
  ["ffm_kg", "Fat-free mass", "kg", "Composition"],
  ["muscle_mass_kg", "Muscle mass", "kg", "Composition"],
  ["tbw_kg", "Body water", "kg", "Water & tissue"],
  ["tbw_percent", "Body water", "%", "Water & tissue"],
  ["body_water_l", "Body water", "L", "Water & tissue"],
  ["bone_mass_kg", "Bone mass", "kg", "Water & tissue"],
  ["protein_kg", "Protein", "kg", "Water & tissue"],
  ["minerals_kg", "Minerals", "kg", "Water & tissue"],
  ["bmr_kcal", "Basal metabolic rate", "kcal/day", "Energy & indices"],
  ["bmr_kj", "Basal metabolic rate", "kJ/day", "Energy & indices"],
  ["tdee_kcal", "Estimated daily expenditure", "kcal/day", "Energy & indices"],
  ["bmi", "BMI", "kg/m²", "Energy & indices"],
  ["visceral_fat_rating", "Visceral fat rating", "", "Energy & indices"],
  ["metabolic_age", "Metabolic age", "years", "Energy & indices"],
  ["physical_age", "Physical age", "years", "Energy & indices"],
  ["ideal_body_weight_kg", "Report ideal weight", "kg", "Report targets"],
  ["degree_of_obesity_percent", "Degree of obesity", "%", "Energy & indices"],
];
export const BODY_METRICS = specs.map(([key, label, unit, group]) => ({
  key,
  label,
  unit,
  group,
  path: ["metrics", key],
  kind: "body_composition",
}));
for (const [key, label, unit] of [
  ["target_weight_kg", "Target weight", "kg"],
  ["weight_control_kg", "Weight control", "kg"],
  ["muscle_control_kg", "Muscle control", "kg"],
  ["fat_control_kg", "Fat control", "kg"],
])
  BODY_METRICS.push({
    key,
    label,
    unit,
    group: "Report targets",
    path: ["targets", key],
    kind: "body_composition",
  });
BODY_METRICS.push({
  key: "analysis_score",
  label: "Analysis score",
  unit: "points",
  group: "Energy & indices",
  path: ["analysis", "score"],
  kind: "body_composition",
});
for (const frequency of ["6.25_khz", "50_khz"])
  for (const measure of ["r_ohm", "x_ohm"]) {
    BODY_METRICS.push({
      key: `${frequency}_${measure}`,
      label: `${measure === "r_ohm" ? "Resistance" : "Reactance"} · ${frequency.replace("_khz", " kHz")}`,
      unit: "Ω",
      group: "Bioelectrical",
      path: ["bioelectrical", frequency, measure],
      kind: "body_composition",
    });
  }
for (const [key, label] of [
  ["fat_percent", "Body fat"],
  ["bmi", "BMI"],
  ["muscle_mass", "Muscle mass"],
  ["bmr", "BMR"],
]) {
  BODY_METRICS.push({
    key: `indicator_${key}`,
    label: `${label} indicator`,
    unit: "% of bar",
    group: "Printed indicators",
    path: ["indicators", key, "position"],
    scale: 100,
    kind: "body_composition",
  });
}
export const WORKOUT_METRICS = [
  {
    key: "duration_minutes",
    label: "Session duration",
    unit: "min",
    path: ["duration_minutes"],
  },
  {
    key: "active_energy_kcal",
    label: "Active energy",
    unit: "kcal",
    path: ["active_energy_kcal"],
  },
  {
    key: "average_bpm",
    label: "Average heart rate",
    unit: "bpm",
    path: ["heart_rate_bpm", "average_bpm"],
  },
  {
    key: "max_bpm",
    label: "Peak heart rate",
    unit: "bpm",
    path: ["heart_rate_bpm", "max_bpm"],
  },
  {
    key: "min_bpm",
    label: "Lowest heart rate",
    unit: "bpm",
    path: ["heart_rate_bpm", "min_bpm"],
  },
].map((x) => ({ ...x, group: "Training", kind: "workout" }));
export const TRAINING_CONTEXT = [
  {
    key: "prior_training_minutes",
    label: "Prior 28 days · recorded training",
    unit: "min",
    kind: "training_context",
  },
  {
    key: "prior_training_sessions",
    label: "Prior 28 days · recorded sessions",
    unit: "sessions",
    kind: "training_context",
  },
];
export const numeric = (value) =>
  typeof value === "number" && Number.isFinite(value);
export const humanize = (value) =>
  String(value)
    .replace(/_/g, " ")
    .replace(/\b\w/, (c) => c.toUpperCase());
export const logDate = (log) => log?.measured_at_local || log?.start_at || "";
export function dayStamp(value) {
  const date = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const t = Date.parse(date + "T00:00:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === date
    ? t
    : NaN;
}
export function todayStamp(now = new Date()) {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}
export const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
export function metricValue(log, spec) {
  const value = spec.path.reduce((a, k) => a?.[k], log);
  return numeric(value) ? value * (spec.scale || 1) : null;
}
export function metricCatalog(logs) {
  const known = new Set(
    BODY_METRICS.filter((x) => x.path[0] === "metrics").map((x) => x.key),
  );
  const extra = new Map();
  for (const log of logs)
    for (const [key, value] of Object.entries(log.metrics || {})) {
      if (numeric(value) && !known.has(key))
        extra.set(key, {
          key,
          label: humanize(key),
          unit: "",
          group: "Other measurements",
          path: ["metrics", key],
          kind: "body_composition",
        });
    }
  return [...BODY_METRICS, ...extra.values(), ...WORKOUT_METRICS].filter(
    (spec) =>
      logs.some(
        (log) => log.kind === spec.kind && metricValue(log, spec) !== null,
      ),
  );
}
export function pointsFor(
  logs,
  spec,
  { source = "all", start = -Infinity, end = Infinity } = {},
) {
  return logs
    .filter(
      (log) =>
        log.kind === spec.kind &&
        (source === "all" || log.source?.type === source),
    )
    .map((log) => ({
      t: dayStamp(logDate(log)),
      v: metricValue(log, spec),
      source: log.source?.type || "unknown",
      log,
    }))
    .filter(
      (p) => Number.isFinite(p.t) && p.v !== null && p.t >= start && p.t <= end,
    )
    .sort((a, b) => a.t - b.t || logDate(a.log).localeCompare(logDate(b.log)));
}
export function preferredSource(points) {
  return (
    ["accuniq_report", "tanita_receipt", "apple_health_export"].find((s) =>
      points.some((p) => p.source === s),
    ) ||
    points[0]?.source ||
    "all"
  );
}
export function latestReference(logs, spec) {
  const points = pointsFor(logs, spec);
  const source = preferredSource(points);
  return points.filter((p) => p.source === source).at(-1) || null;
}
export function median(values) {
  const a = values.filter(numeric).sort((a, b) => a - b);
  return a.length
    ? (a[Math.floor((a.length - 1) / 2)] + a[Math.floor(a.length / 2)]) / 2
    : null;
}
export function dailyMedians(points) {
  const groups = new Map();
  for (const p of points) {
    const key = `${p.source}:${p.t}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g.at(-1),
      v: median(g.map((p) => p.v)),
      count: g.length,
    }))
    .sort((a, b) => a.t - b.t);
}
export function smoothPoints(points, days = 28) {
  const daily = dailyMedians(points);
  return daily.map((p) => ({
    ...p,
    v: median(
      daily
        .filter(
          (q) => q.source === p.source && q.t <= p.t && q.t > p.t - days * DAY,
        )
        .map((q) => q.v),
    ),
  }));
}
export function summarise(points) {
  if (!points.length) return null;
  return {
    latest: points.at(-1).v,
    first: points[0].v,
    change: points.at(-1).v - points[0].v,
    count: points.length,
    min: Math.min(...points.map((p) => p.v)),
    max: Math.max(...points.map((p) => p.v)),
    median: median(points.map((p) => p.v)),
    span: (points.at(-1).t - points[0].t) / DAY,
  };
}
export function rangeBounds(range, logs, now = todayStamp()) {
  const dates = logs.map((l) => dayStamp(logDate(l))).filter(Number.isFinite);
  const end = now;
  const span = { "1M": 30, "3M": 90, "6M": 180, "1Y": 365 }[range];
  return {
    start: span ? end - (span - 1) * DAY : Math.min(end - 29 * DAY, ...dates),
    end,
  };
}
export function pairedMetrics(logs, xSpec, ySpec, options) {
  if (ySpec.kind === "training_context") {
    const workouts = logs.filter(
      (l) => l.kind === "workout" && Number.isFinite(dayStamp(logDate(l))),
    );
    if (!workouts.length) return [];
    const first = Math.min(...workouts.map((l) => dayStamp(logDate(l)))),
      last = Math.max(...workouts.map((l) => dayStamp(logDate(l))));
    return pointsFor(logs, xSpec, options)
      .filter((p) => p.t - 28 * DAY >= first && p.t <= last + DAY)
      .map((p) => {
        const prior = workouts.filter((l) => {
          const t = dayStamp(logDate(l));
          return t >= p.t - 28 * DAY && t < p.t;
        });
        return {
          ...p,
          x: p.v,
          y:
            ySpec.key === "prior_training_sessions"
              ? prior.length
              : prior.reduce(
                  (n, l) =>
                    n + (numeric(l.duration_minutes) ? l.duration_minutes : 0),
                  0,
                ),
        };
      });
  }
  return pointsFor(logs, xSpec, options)
    .map((p) => ({ ...p, x: p.v, y: metricValue(p.log, ySpec) }))
    .filter((p) => p.y !== null && p.log.kind === ySpec.kind);
}
export function correlation(pairs) {
  const n = pairs.length;
  if (n < 4) return null;
  const mx = pairs.reduce((s, p) => s + p.x, 0) / n,
    my = pairs.reduce((s, p) => s + p.y, 0) / n;
  let xx = 0,
    yy = 0,
    xy = 0;
  for (const p of pairs) {
    const x = p.x - mx,
      y = p.y - my;
    xx += x * x;
    yy += y * y;
    xy += x * y;
  }
  return xx > 0 && yy > 0
    ? Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy)))
    : null;
}
export function devicePairs(logs, spec, maxDays = 3) {
  const acc = pointsFor(logs, spec, { source: "accuniq_report" }),
    tan = pointsFor(logs, spec, { source: "tanita_receipt" }),
    used = new Set(),
    pairs = [];
  for (const a of acc) {
    const b = tan
      .filter(
        (p) => !used.has(p.log.id) && Math.abs(p.t - a.t) <= maxDays * DAY,
      )
      .sort((x, y) => Math.abs(x.t - a.t) - Math.abs(y.t - a.t))[0];
    if (b) {
      used.add(b.log.id);
      pairs.push({ a, b, difference: b.v - a.v });
    }
  }
  return { pairs, medianDifference: median(pairs.map((p) => p.difference)) };
}
export function projectTrend(points, now = todayStamp(), horizon = 28) {
  if (new Set(points.map((p) => p.source)).size > 1)
    return { reason: "Choose one device for a projection." };
  const recent = dailyMedians(
    points.filter((p) => p.t >= now - 90 * DAY && p.t <= now),
  );
  if (recent.length < 6)
    return {
      reason: `Needs 6 measurement days in the last 90 days; ${recent.length} available.`,
    };
  const first = recent[0].t,
    last = recent.at(-1).t;
  if (last - first < 28 * DAY)
    return { reason: "Needs at least 28 days of measurement history." };
  if (now - last > 30 * DAY)
    return { reason: "The latest measurement is over 30 days old." };
  if (recent.some((p, i) => i > 0 && p.t - recent[i - 1].t > 45 * DAY))
    return { reason: "A gap over 45 days makes this recent trend too sparse." };
  const n = recent.length,
    xy = recent.map((p) => ({ x: (p.t - first) / DAY, y: p.v }));
  const mx = xy.reduce((s, p) => s + p.x, 0) / n,
    my = xy.reduce((s, p) => s + p.y, 0) / n;
  const sxx = xy.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const slope = xy.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / sxx,
    intercept = my - slope * mx;
  const residual = Math.sqrt(
    xy.reduce((s, p) => s + (p.y - intercept - slope * p.x) ** 2, 0) / (n - 2),
  );
  const t95 = [
    null,
    null,
    null,
    null,
    2.776,
    2.571,
    2.447,
    2.365,
    2.306,
    2.262,
    2.228,
    2.201,
    2.179,
    2.16,
    2.145,
    2.131,
    2.12,
    2.11,
    2.101,
    2.093,
    2.086,
    2.08,
    2.074,
    2.069,
    2.064,
    2.06,
    2.056,
    2.052,
    2.048,
    2.045,
    2.042,
  ][Math.min(30, n - 2)];
  const projection = [];
  for (let d = 0; d <= Math.min(28, Math.max(1, horizon)); d += 1) {
    const t = now + d * DAY,
      x = (t - first) / DAY,
      v = intercept + slope * x,
      band = t95 * residual * Math.sqrt(1 + 1 / n + (x - mx) ** 2 / sxx);
    projection.push({
      t,
      v,
      low: v - band,
      high: v + band,
      source: recent[0].source,
    });
  }
  return {
    points: projection,
    slopePerWeek: slope * 7,
    n,
    history: recent,
    span: (last - first) / DAY,
  };
}
export function compositionScenario(log, fatPercent, leanChange = 0) {
  const m = log?.metrics || {};
  const fat = numeric(m.fat_mass_kg)
    ? m.fat_mass_kg
    : numeric(m.weight_kg) && numeric(m.fat_percent)
      ? (m.weight_kg * m.fat_percent) / 100
      : null;
  const lean = numeric(m.ffm_kg)
    ? m.ffm_kg
    : numeric(m.weight_kg) && fat !== null
      ? m.weight_kg - fat
      : null;
  if (
    !numeric(lean) ||
    !numeric(fatPercent) ||
    fatPercent <= 0 ||
    fatPercent >= 100 ||
    !numeric(leanChange) ||
    lean + leanChange <= 0
  )
    return null;
  const leanMass = lean + leanChange,
    weight = leanMass / (1 - fatPercent / 100);
  return {
    weight,
    fatMass: weight - leanMass,
    leanMass,
    change: numeric(m.weight_kg) ? weight - m.weight_kg : null,
  };
}
export function workoutBuckets(logs, { start, end }, size = 7) {
  const result = [];
  for (let t = start; t <= end; t += size * DAY)
    result.push({
      t,
      end: Math.min(end, t + (size - 1) * DAY),
      minutes: 0,
      energy: 0,
      energyCount: 0,
      count: 0,
      logs: [],
    });
  for (const log of logs) {
    const t = dayStamp(logDate(log));
    if (log.kind !== "workout" || t < start || t > end) continue;
    const b = result[Math.floor((t - start) / (size * DAY))];
    if (b) {
      b.count++;
      b.logs.push(log);
      if (numeric(log.duration_minutes)) b.minutes += log.duration_minutes;
      if (numeric(log.active_energy_kcal)) {
        b.energy += log.active_energy_kcal;
        b.energyCount++;
      }
    }
  }
  return result;
}
export function heartRateSeries(log) {
  const start = Date.parse(log?.start_at),
    end = Date.parse(log?.end_at);
  const samples = Array.isArray(log?.heart_rate_bpm?.samples)
    ? log.heart_rate_bpm.samples
    : [];
  const unique = new Map();
  for (const s of samples) {
    const at = Date.parse(s.at);
    if (
      numeric(s.bpm) &&
      s.bpm > 0 &&
      Number.isFinite(at) &&
      at >= start &&
      at <= end
    )
      unique.set(at, { t: (at - start) / 60_000, v: s.bpm, at: s.at });
  }
  return [...unique.values()].sort((a, b) => a.t - b.t);
}
export function heartRateDistribution(log) {
  const points = heartRateSeries(log),
    thresholds = [100, 120, 140, 160, Infinity],
    labels = ["< 100", "100–119", "120–139", "140–159", "160+"];
  const bins = thresholds.map((max, i) => ({
    label: labels[i],
    max,
    seconds: 0,
  }));
  for (let i = 0; i < points.length - 1; i++) {
    const seconds = (points[i + 1].t - points[i].t) * 60;
    if (seconds > 0 && seconds <= 60)
      bins.find((b) => points[i].v < b.max).seconds += seconds;
  }
  const seconds = bins.reduce((n, b) => n + b.seconds, 0),
    elapsed = (Date.parse(log.end_at) - Date.parse(log.start_at)) / 1000;
  return {
    bins,
    seconds,
    coverage: elapsed > 0 ? Math.min(1, seconds / elapsed) : 0,
    points,
  };
}
export function qualitativeHistory(logs) {
  return logs
    .filter((l) => l.kind === "body_composition")
    .flatMap((log) =>
      Object.entries(log.qualitative || {})
        .filter(([, value]) => typeof value === "string" && value.trim())
        .map(([key, value]) => ({ log, key, value })),
    )
    .sort((a, b) => logDate(b.log).localeCompare(logDate(a.log)));
}
export function recordIssues(log) {
  const m = log.metrics || {},
    issues = [];
  if (numeric(m.fat_percent) && (m.fat_percent < 0 || m.fat_percent > 100))
    issues.push("Body fat is outside 0–100%.");
  if (numeric(m.weight_kg) && m.weight_kg <= 0)
    issues.push("Weight must be above zero.");
  if (
    numeric(m.weight_kg) &&
    numeric(m.fat_mass_kg) &&
    m.fat_mass_kg > m.weight_kg
  )
    issues.push("Fat mass exceeds total weight.");
  if (
    numeric(m.weight_kg) &&
    numeric(m.ffm_kg) &&
    numeric(m.fat_mass_kg) &&
    Math.abs(m.weight_kg - m.ffm_kg - m.fat_mass_kg) > 1
  )
    issues.push("Fat plus fat-free mass differs from weight by over 1 kg.");
  if (!Number.isFinite(dayStamp(logDate(log))))
    issues.push("Measurement date is missing or invalid.");
  return issues;
}
