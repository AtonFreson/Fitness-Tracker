import test from "node:test";
import assert from "node:assert/strict";
import { mergeHealthWorkouts } from "../src/health-records.js";

test('XML-only reimports retain route and calories even without heart-rate data',()=>{
  const old={id:'ride',kind:'workout',active_energy_kcal:100,basal_energy_kcal:50,route:{points:[{latitude:1,longitude:2}]}};
  const [result]=mergeHealthWorkouts([old],[{id:'ride',kind:'workout',active_energy_kcal:null,route:{points:[]}}]);
  assert.equal(result.total_energy_kcal,150);
  assert.equal(result.route.points.length,1);
});

test("a newer sparse Health export retains old samples and deduplicates equivalent timestamps", () => {
  const a = { at: "2030-01-01T10:00:00+08:00", bpm: 100 };
  const b = { at: "2030-01-01T10:00:05+08:00", bpm: 110 };
  const old = {
    id: "workout",
    kind: "workout",
    heart_rate_bpm: { average_bpm: 105, samples: [a, b] },
  };
  const fresh = {
    id: "workout",
    kind: "workout",
    heart_rate_bpm: {
      average_bpm: 106,
      samples: [{ ...a, at: "2030-01-01T02:00:00Z" }],
    },
  };
  const [merged] = mergeHealthWorkouts([old], [fresh]);
  assert.equal(merged.heart_rate_bpm.samples.length, 2);
  assert.equal(merged.heart_rate_bpm.average_bpm, 106);
  assert.deepEqual(mergeHealthWorkouts([merged], [fresh]), [merged]);
  assert.equal(
    mergeHealthWorkouts([old], [{ ...fresh, heart_rate_bpm: null }])[0]
      .heart_rate_bpm.samples.length,
    2,
  );
});
