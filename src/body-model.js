import { DAY, dayStamp, logDate, numeric, todayStamp } from './analytics.js';

// Six-state local trend: fat, fat-free mass, their daily rates, TANITA fat
// offset, TANITA scale offset. ACCUNIQ defines the reference, not ground truth.
const N = 6;
const zero = (r=N,c=N) => Array.from({length:r},()=>Array(c).fill(0));
const identity = () => Array.from({length:N},(_,i)=>Array.from({length:N},(_,j)=>+(i===j)));
const transpose = a => a[0].map((_,i)=>a.map(r=>r[i]));
const mul = (a,b) => a.map(r=>b[0].map((_,j)=>r.reduce((s,x,k)=>s+x*b[k][j],0)));
const add = (a,b) => a.map((r,i)=>r.map((x,j)=>x+b[i][j]));
const inverse2 = a => {
  const d=a[0][0]*a[1][1]-a[0][1]*a[1][0];
  return d>1e-12 ? [[a[1][1]/d,-a[0][1]/d],[-a[1][0]/d,a[0][0]/d]] : null;
};
export const MODEL_METRICS = ['weight_kg','fat_percent','fat_mass_kg','ffm_kg'];
export const MODEL_NOISE = {
  accuniq_report: {weightKg:.5, fatPercentagePoints:1.5},
  tanita_receipt: {weightKg:.5, fatPercentagePoints:3},
};

function observation(log) {
  const m=log.metrics||{}, t=dayStamp(logDate(log));
  const weight=m.weight_kg;
  const fat=numeric(m.fat_mass_kg) ? m.fat_mass_kg : numeric(m.fat_percent) ? weight*m.fat_percent/100 : numeric(m.ffm_kg) ? weight-m.ffm_kg : null;
  if(!MODEL_NOISE[log.source?.type] || !Number.isFinite(t) || !numeric(weight) || !numeric(fat) || weight<=0 || fat<=0 || fat>=weight) return null;
  return {t,weight,fat,source:log.source.type,log};
}
function predict(state, days) {
  let {x,P}=state;
  for(let left=days;left>0;left-=1) {
    const dt=Math.min(1,left), decay=Math.exp(-dt/28), travel=28*(1-decay);
    const F=identity(); F[0][2]=travel;F[1][3]=travel;F[2][2]=decay;F[3][3]=decay;
    x=mul(F,x.map(v=>[v])).map(r=>r[0]);
    const Q=zero();
    [.035**2,.10**2,.003**2,.006**2,.006**2,.002**2].forEach((v,i)=>Q[i][i]=v*dt);
    P=add(mul(mul(F,P),transpose(F)),Q);
  }
  return {x,P};
}
function update(state, o, blended, scale) {
  const tan=blended && o.source==='tanita_receipt';
  const H=[[1,1,0,0,0,+tan],[1,0,0,0,+tan,0]];
  const noise=MODEL_NOISE[o.source], vw=(noise.weightKg*scale)**2, fraction=o.fat/o.weight;
  let R=[[vw,fraction*vw],[fraction*vw,fraction**2*vw+(o.weight*noise.fatPercentagePoints*scale/100)**2]];
  const {x,P}=state, residual=[o.weight,o.fat].map((z,i)=>z-H[i].reduce((s,h,j)=>s+h*x[j],0));
  const PH=mul(P,transpose(H)), predicted=mul(H,PH);
  let S=add(predicted,R), inv=inverse2(S);
  if(!inv)return {...state,downweighted:false};
  const distance=mul(mul([residual],inv),transpose([residual]))[0][0];
  const downweighted=distance>9;
  if(downweighted) {R=R.map(r=>r.map(v=>v*distance/9));S=add(predicted,R);inv=inverse2(S);}
  if(!inv)return {...state,downweighted};
  const K=mul(PH,inv), next=x.map((v,i)=>v+K[i].reduce((s,k,j)=>s+k*residual[j],0));
  if(next[0]<=0||next[1]<=0)return {...state,downweighted:true};
  const KH=mul(K,H), A=identity().map((r,i)=>r.map((v,j)=>v-KH[i][j]));
  const covariance=add(mul(mul(A,P),transpose(A)),mul(mul(K,R),transpose(K)));
  // Joseph form plus symmetry keeps the covariance positive under roundoff.
  return {x:next,P:covariance.map((r,i)=>r.map((v,j)=>(v+covariance[j][i])/2)),downweighted};
}
export function modelValue(state,key) {
  const [fat,lean]=state.x, weight=fat+lean;
  const gradients={fat_mass_kg:[1,0],ffm_kg:[0,1],weight_kg:[1,1],fat_percent:[100*lean/weight**2,-100*fat/weight**2]};
  const g=gradients[key];if(!g)return null;
  const values={fat_mass_kg:fat,ffm_kg:lean,weight_kg:weight,fat_percent:100*fat/weight};
  const variance=g[0]**2*state.P[0][0]+2*g[0]*g[1]*state.P[0][1]+g[1]**2*state.P[1][1];
  // A shared uncertainty floor prevents repeated BIA readings implying accuracy
  // against an external reference. These are explicit product assumptions.
  const floor=key==='fat_percent'?1.5:key==='weight_kg'?.35:1;
  const sigma=Math.sqrt(Math.max(0,variance)+floor**2), v=values[key];
  return {v,low:Math.max(0,v-1.96*sigma),high:key==='fat_percent'?Math.min(100,v+1.96*sigma):v+1.96*sigma,sigma};
}
export function fitBodyModel(logs,{now=todayStamp(),source='all',noiseScale=1,horizon=28}={}) {
  const days=new Map();
  logs.filter(l=>l.kind==='body_composition').sort((a,b)=>logDate(a).localeCompare(logDate(b))).forEach(l=>{
    const o=observation(l);if(o && o.t<=now && (source==='all'||source===o.source))days.set(o.source+':'+o.t,o);
  });
  const observations=[...days.values()].sort((a,b)=>a.t-b.t || a.source.localeCompare(b.source));
  if(!observations.length)return {reason:'Needs weight and fat mass or fat percentage in a body report.',history:[],forecast:[],observations:[]};
  const sources=[...new Set(observations.map(o=>o.source))],blended=sources.length>1;
  const first=observations[0],x=[first.fat,first.weight-first.fat,0,0,0,0],P=zero();
  [9,9,.03**2,.05**2,blended?3**2:0,blended?.5**2:0].forEach((v,i)=>P[i][i]=v);
  let state={x,P},t=first.t,downweighted=0;
  const history=[];
  for(const o of observations) {
    state=predict(state,(o.t-t)/DAY);t=o.t;
    state=update(state,o,blended,Math.min(3,Math.max(.5,noiseScale)));
    if(state.downweighted)downweighted++;
    const point={t,state:{x:[...state.x],P:state.P.map(r=>[...r])},log:o.log};
    if(history.at(-1)?.t===t)history[history.length-1]=point;else history.push(point);
  }
  const last=t, recent=history.filter(p=>p.t>=now-90*DAY);
  let reason=null;
  if(recent.length<6)reason=`Needs 6 measurement days in the last 90 days; ${recent.length} available.`;
  else if(recent.at(-1).t-recent[0].t<28*DAY)reason='Needs at least 28 days of recent measurement history.';
  else if(now-last>30*DAY)reason='The latest body reading is over 30 days old.';
  else if(recent.some((p,i)=>i>0&&p.t-recent[i-1].t>45*DAY))reason='A recent gap over 45 days makes prediction too uncertain.';
  const latestAnchor=observations.filter(o=>o.source==='accuniq_report').at(-1);
  if(!reason && blended && now-latestAnchor.t>90*DAY)reason='The ACCUNIQ reference is over 90 days old. Add a reference reading or select one device.';
  const forecast=[];
  if(!reason){
    state=predict(state,(now-last)/DAY);
    for(let d=0;d<=Math.min(28,Math.max(1,horizon));d++) {
      if(d)state=predict(state,1);
      if(state.x[0]<=0||state.x[1]<=0){reason='The projected composition left the physical range.';forecast.length=0;break;}
      forecast.push({t:now+d*DAY,state:{x:[...state.x],P:state.P.map(r=>[...r])}});
    }
  }
  return {history,forecast,observations,reason,sources,blended,downweighted,n:recent.length,last,reference:latestAnchor?'ACCUNIQ':'TANITA',bias:blended?{fatKg:history.at(-1).state.x[4],weightKg:history.at(-1).state.x[5],fatSigma:Math.sqrt(history.at(-1).state.P[4][4])}:null};
}
