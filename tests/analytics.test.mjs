import test from "node:test";
import assert from "node:assert/strict";
import {
  DAY,
  BODY_METRICS,
  TRAINING_CONTEXT,
  metricCatalog,
  metricValue,
  pointsFor,
  preferredSource,
  latestReference,
  dayStamp,
  smoothPoints,
  projectTrend,
  correlation,
  pairedMetrics,
  devicePairs,
  compositionScenario,
  heartRateDistribution,
  qualitativeHistory,
  workoutBuckets,
} from "../src/analytics.js";

const fat = BODY_METRICS.find((m) => m.key === "fat_percent");
const weight = BODY_METRICS.find((m) => m.key === "weight_kg");
const body = (date, source, metrics, more = {}) => ({
  id: `${source}:${date}`,
  kind: "body_composition",
  source: { type: source },
  measured_at_local: date,
  metrics,
  ...more,
});
const acc = "accuniq_report",
  tan = "tanita_receipt";

test("missing values stay missing; unseen numeric metrics remain explorable", () => {
  const logs = [
    body("2030-01-01", acc, {
      weight_kg: null,
      fat_percent: 20,
      novel_index: 4,
    }),
  ];
  assert.equal(metricValue(logs[0], weight), null);
  assert.equal(pointsFor(logs, weight).length, 0);
  assert.ok(metricCatalog(logs).some((s) => s.key === "novel_index"));
});
test("source preference is explicit, with actual date, and never pools devices", () => {
  const logs = [
    body("2030-01-01", acc, { fat_percent: 20 }),
    body("2030-02-01", tan, { fat_percent: 25 }),
  ];
  assert.equal(preferredSource(pointsFor(logs, fat)), acc);
  assert.equal(latestReference(logs, fat).v, 20);
  assert.equal(latestReference(logs, fat).t, dayStamp("2030-01-01"));
  assert.match(projectTrend(pointsFor(logs, fat)).reason, /one device/);
});
test("calendar grouping preserves recorded local dates across timezone offsets", () => {
  assert.equal(dayStamp("2030-01-01T01:00:00+08:00"), Date.UTC(2030, 0, 1));
  assert.ok(Number.isNaN(dayStamp("2030-02-31")));
});
test("smoothing takes daily medians and keeps device histories separate", () => {
  const ps = [
    { t: 0, v: 10, source: tan },
    { t: 0, v: 30, source: tan },
    { t: DAY, v: 100, source: acc },
    { t: 2 * DAY, v: 22, source: tan },
    { t: 31 * DAY, v: 50, source: tan },
  ];
  const smoothed = smoothPoints(ps);
  assert.equal(smoothed.find((p) => p.t === 2 * DAY).v, 21);
  assert.equal(smoothed.find((p) => p.source === acc).v, 100);
  assert.equal(smoothed.at(-1).v, 50);
});
test("projection enforces sample count, spacing, recency, source and horizon gates", () => {
  const now = Date.UTC(2030, 4, 1);
  const ps = Array.from({ length: 8 }, (_, i) => ({
    t: now - (49 - i * 7) * DAY,
    v: 70 - i * 0.1,
    source: tan,
  }));
  const p = projectTrend(ps, now, 200);
  assert.equal(p.n, 8);
  assert.equal(p.points.length, 29);
  assert.ok(Math.abs(p.slopePerWeek + 0.1) < 1e-9);
  assert.ok(p.points.every((p) => p.low <= p.v && p.v <= p.high));
  assert.match(projectTrend(ps.slice(0, 3), now).reason, /6 measurement/);
  assert.match(
    projectTrend(
      ps.map((p) => ({ ...p, t: p.t - 40 * DAY })),
      now,
    ).reason,
    /30 days/,
  );
});
test("comparison pairs values from the same record, never nearest records or other devices", () => {
  const logs = Array.from({ length: 4 }, (_, i) =>
    body(`2030-01-0${i + 1}`, acc, { weight_kg: 70 + i, fat_percent: 20 + i }),
  );
  logs.push(body("2030-01-03", tan, { weight_kg: 100, fat_percent: 40 }));
  const pairs = pairedMetrics(logs, weight, fat, { source: acc });
  assert.equal(pairs.length, 4);
  assert.ok(Math.abs(correlation(pairs) - 1) < 1e-9);
  assert.equal(correlation(pairs.slice(0, 3)), null);
  assert.equal(correlation(pairs.map((p) => ({ ...p, x: 1 }))), null);
});
test("device comparisons enforce proximity and do not reuse a TANITA reading", () => {
  const logs = [
    body("2030-01-01", acc, { weight_kg: 70 }),
    body("2030-01-02", acc, { weight_kg: 71 }),
    body("2030-01-02", tan, { weight_kg: 72 }),
    body("2030-01-20", tan, { weight_kg: 90 }),
  ];
  assert.equal(devicePairs(logs, weight).pairs.length, 1);
});
test("training context excludes the measurement day and incomplete leading windows", () => {
  const logs = [
    body("2030-01-10", acc, { fat_percent: 25 }),
    body("2030-02-01", acc, { fat_percent: 24 }),
    ...["2030-01-01", "2030-01-10", "2030-01-30", "2030-02-01"].map(
      (start_at, i) => ({
        id: "w" + i,
        kind: "workout",
        start_at,
        duration_minutes: 60,
      }),
    ),
  ];
  const pairs = pairedMetrics(logs, fat, TRAINING_CONTEXT[0], { source: acc });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].y, 120);
});
test("composition model does not add water or muscle to fat-free mass", () => {
  const log = body("2030-01-01", acc, {
    weight_kg: 80,
    ffm_kg: 60,
    fat_mass_kg: 20,
    muscle_mass_kg: 55,
    body_water_l: 40,
  });
  const model = compositionScenario(log, 20, 0);
  assert.equal(model.weight, 75);
  assert.equal(model.fatMass, 15);
  assert.equal(model.leanMass, 60);
  assert.equal(compositionScenario(log, 100), null);
});
test("heart-rate duration excludes long gaps and does not mistake sample count for time", () => {
  const log = {
    start_at: "2030-01-01T00:00:00Z",
    end_at: "2030-01-01T00:05:00Z",
    heart_rate_bpm: {
      samples: [
        { at: "2030-01-01T00:00:00Z", bpm: 90 },
        { at: "2030-01-01T00:00:10Z", bpm: 110 },
        { at: "2030-01-01T00:03:00Z", bpm: 140 },
        { at: "2030-01-01T00:03:30Z", bpm: 145 },
      ],
    },
  };
  const d = heartRateDistribution(log);
  assert.equal(d.seconds, 40);
  assert.equal(d.bins[0].seconds, 10);
  assert.equal(d.bins[3].seconds, 30);
  assert.ok(Math.abs(d.coverage - 40 / 300) < 1e-9);
});
test("classification strings, punctuation and unfamiliar categories survive verbatim", () => {
  const value = "HIDDEN OBESE — level 2 / unusual wording";
  const logs = [
    body("2030-01-01", tan, {}, { qualitative: { physique_rating: value } }),
  ];
  assert.equal(qualitativeHistory(logs)[0].value, value);
});
test("recorded workout periods have explicit empty intervals and include the final day", () => {
  const start = dayStamp("2030-01-01"),
    end = start + 13 * DAY;
  const logs = [
    {
      id: "w",
      kind: "workout",
      start_at: "2030-01-14T23:00:00+08:00",
      duration_minutes: 60,
      active_energy_kcal: 100,
    },
  ];
  const bs = workoutBuckets(logs, { start, end });
  assert.equal(bs.length, 2);
  assert.equal(bs[0].count, 0);
  assert.equal(bs[1].minutes, 60);
});
