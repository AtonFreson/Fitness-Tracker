import test from 'node:test';
import assert from 'node:assert/strict';
import {fitBodyModel,modelValue} from '../src/body-model.js';
import {DAY} from '../src/analytics.js';
const start=Date.UTC(2030,0,1), acc='accuniq_report',tan='tanita_receipt';
const body=(day,source,fat=16,weight=72)=>({id:source+day,kind:'body_composition',measured_at_local:new Date(start+day*DAY).toISOString(),source:{type:source},metrics:{weight_kg:weight,fat_mass_kg:fat}});
test('joint body state conserves mass; uncertainty grows through prediction',()=>{
  const logs=Array.from({length:10},(_,i)=>body(i*7,acc,16-i*.1,72-i*.08));
  const m=fitBodyModel(logs,{now:start+63*DAY,horizon:100});
  assert.equal(m.reason,null);assert.equal(m.forecast.length,29);
  for(const p of [...m.history,...m.forecast]){
    const f=modelValue(p.state,'fat_mass_kg'),l=modelValue(p.state,'ffm_kg'),w=modelValue(p.state,'weight_kg');
    assert.ok(Math.abs(f.v+l.v-w.v)<1e-9);assert.ok(f.v>0 && l.v>0);
    assert.ok(w.low<w.v && w.high>w.v);
    p.state.P.forEach((r,i)=>assert.ok(r[i]>=0));
  }
  assert.ok(modelValue(m.forecast.at(-1).state,'fat_mass_kg').sigma>modelValue(m.forecast[0].state,'fat_mass_kg').sigma);
});
test('a repeatable device offset is attributed to TANITA, not gained fat',()=>{
  const logs=Array.from({length:15},(_,i)=>[body(i*4,acc),body(i*4,tan,19)]).flat();
  const m=fitBodyModel(logs,{now:start+56*DAY});
  assert.ok(m.bias.fatKg>2);assert.ok(Math.abs(modelValue(m.history.at(-1).state,'fat_mass_kg').v-16)<.7);
  assert.ok(m.bias.fatSigma>0);
});
test('ACCUNIQ receives greater composition influence and extreme readings are downweighted',()=>{
  const common=Array.from({length:12},(_,i)=>body(i*5,acc));
  const a=fitBodyModel([...common,body(60,acc,18)],{now:start+60*DAY,source:acc});
  const t=fitBodyModel([...common.map(l=>({...l,source:{type:tan}})),body(60,tan,18)],{now:start+60*DAY,source:tan});
  assert.ok(a.history.at(-1).state.x[0]>t.history.at(-1).state.x[0]);
  const outlier=fitBodyModel([...common,body(60,acc,40)],{now:start+60*DAY});
  assert.ok(outlier.downweighted>0);assert.ok(outlier.history.at(-1).state.x[0]<25);
});
test('no future leakage; sparse and stale measurements do not produce a forecast',()=>{
  const logs=Array.from({length:10},(_,i)=>body(i*7,acc));
  const now=start+63*DAY;
  assert.deepEqual(fitBodyModel([...logs,body(70,acc,30)],{now}),fitBodyModel(logs,{now}));
  assert.ok(fitBodyModel(logs.slice(0,3),{now}).reason);
  assert.equal(fitBodyModel(logs,{now:now+40*DAY}).forecast.length,0);
  assert.equal(fitBodyModel([body(0,acc,80,70)],{now}).history.length,0);
});
