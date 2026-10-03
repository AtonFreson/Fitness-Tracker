import { escapeHtml as esc, formatNumber as num, lineChart } from './charts.js';
import { validLocation, reportedHeartRateZones } from './workout-details.js';

const label = value => String(value).replace(/^HK(?:QuantityTypeIdentifier|WorkoutEventType|MetadataKey|Workout|)/,'').replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ');
const row = (name,value,unit='') => `<div><dt>${esc(name)}</dt><dd>${esc(value)} <small>${esc(unit)}</small></dd></div>`;
const valueRow = (name,value,unit='') => Number.isFinite(value) ? row(name,num(value),unit) : '';
export function workoutExtras(log) {
  const metadata=log.health_metadata || {}, events=log.workout_events || [], details=log.health_details || {};
  const elapsed=(Date.parse(log.end_at)-Date.parse(log.start_at))/60000;
  const zones=reportedHeartRateZones(log),zoneMinutes=zones.reduce((n,z)=>n+z.minutes,0);
  return `<section class="detail-section"><h2>Session details</h2><dl class="detail-values">
    ${valueRow('Active energy',log.active_energy_kcal,'kcal')}${valueRow('Resting energy',log.basal_energy_kcal,'kcal')}${valueRow('Total energy',log.total_energy_kcal,'kcal')}
    ${valueRow('Elapsed time',elapsed,'min')}${valueRow('Paused time',log.paused_minutes,'min')}${valueRow('Distance',log.distance_km,'km')}
    ${log.distance_km>0 && log.duration_minutes>0 ? valueRow('Average speed',log.distance_km/log.duration_minutes*60,'km/h') : ''}
    ${valueRow('Average effort',log.average_mets,'MET')}${valueRow('Elevation gain',log.elevation_ascended_m,'m')}${valueRow('Outdoor temperature',log.temperature_c,'°C')}${valueRow('Humidity',log.humidity_percent,'%')}
    ${log.indoor != null ? row('Setting reported by source',log.indoor?'Indoor':'Outdoor') : ''}${log.time_zone?row('Time zone',log.time_zone):''}${log.source?.app?row('Recorded by',log.source.app):''}
    </dl><p class="panel-note">Total energy is active plus resting energy during this session. Calories and METs are source estimates. Weather describes outdoor conditions, including for indoor sessions.</p>
    ${metadata.HKWeatherHumidity && log.humidity_percent == null ? '<p class="panel-note">The exported humidity is outside 0–100%; its original value is retained below.</p>' : ''}</section>
    ${zones.length?`<section class="detail-section"><h2>Reported heart-rate zones</h2><p class="panel-note">Zone boundaries and times supplied by the recording app. These can differ from the observed sample distribution above.</p><div class="hr-bins">${zones.map((z,i)=>`<div><span>${z.min===null?'Below '+num(z.max):z.max===null?num(z.min)+'+':num(z.min)+'–'+num(z.max)} <small>bpm</small></span><i style="--portion:${zoneMinutes?100*z.minutes/zoneMinutes:0}%;--bin-color:${['#778ba0','#4c92bb','#528e78','#bb854c','#bf5964'][Math.min(4,i)]}"></i><strong>${num(z.minutes)} <small>min</small></strong></div>`).join('')}</div></section>`:''}
    <section class="detail-section"><h2>Location & route</h2><div id="workout-map"></div>${log.route_warning?`<p class="panel-note">${esc(log.route_warning)}</p>`:''}<div id="route-elevation" class="chart-host"></div><div id="route-speed" class="chart-host"></div></section>
    ${events.length?`<details class="workout-events"><summary>Session timeline · ${events.length} events</summary><ol>${events.map(e=>{const minutes=(Date.parse(e.at || e.date)-Date.parse(log.start_at))/60000;return `<li><time>${num(minutes)} min</time><span>${esc(label(e.type))}${e.duration?` · ${esc(e.duration)} ${esc(e.durationUnit||'')}`:''}</span></li>`;}).join('')}</ol></details>`:''}
    <details class="workout-raw"><summary>All exported workout fields</summary><p class="panel-note">Original source fields are preserved, including values the tracker does not interpret.</p>
      <h3>Metadata</h3><dl class="detail-values">${Object.entries(metadata).map(([k,v])=>row(label(k),v)).join('') || '<p>None in this export.</p>'}</dl>
      <h3>Statistics</h3>${(log.workout_statistics||[]).map(s=>`<h4>${esc(label(s.type))}</h4><dl class="detail-values">${Object.entries(s).filter(([k])=>k!=='type').map(([k,v])=>row(label(k),v)).join('')}</dl>`).join('')}
      ${details.extra_fields?.length?`<h3>Zones & additional fields</h3>${details.extra_fields.map(s=>`<dl class="detail-values">${Object.entries(s).map(([k,v])=>row(label(k),v)).join('')}</dl>`).join('')}`:''}
      <h3>Recording information</h3><dl class="detail-values">${Object.entries(details.attributes||{}).map(([k,v])=>row(label(k),v)).join('')}</dl>
    </details>`;
}
function renderRoute(host,log) {
  const route=(log.route?.points || []).filter(p=>validLocation(p.latitude,p.longitude));
  const pin=log.location;
  const points=route.length?route:validLocation(pin?.latitude,pin?.longitude)?[pin]:[];
  if(!points.length){host.innerHTML='<p class="panel-note">No coordinates are included for this workout in the imported file.</p>';return ()=>{};}
  const merc=p=>({x:(p.longitude+180)/360,y:(1-Math.asinh(Math.tan(Math.max(-85,Math.min(85,p.latitude))*Math.PI/180))/Math.PI)/2});
  const projected=points.map(merc),xs=projected.map(p=>p.x),ys=projected.map(p=>p.y);
  const minx=xs.reduce((a,b)=>Math.min(a,b),Infinity),maxx=xs.reduce((a,b)=>Math.max(a,b),-Infinity),miny=ys.reduce((a,b)=>Math.min(a,b),Infinity),maxy=ys.reduce((a,b)=>Math.max(a,b),-Infinity);
  let center={x:(minx+maxx)/2,y:(miny+maxy)/2},zoom=Math.min(16,Math.max(2,Math.floor(Math.log2(.8/Math.max(maxx-minx,maxy-miny,.00001))))), tiles=false,selected=0;
  const first=points[0];
  host.innerHTML=`<div class="route-toolbar"><button type="button" data-map="out" aria-label="Zoom out">−</button><button type="button" data-map="in" aria-label="Zoom in">+</button><button type="button" data-map="fit">Fit</button><button type="button" data-map="tiles">Load street map</button></div><div class="route-canvas"></div><input class="route-scrubber" type="range" min="0" max="${points.length-1}" value="0" aria-label="Inspect route location"><output class="route-reading" aria-live="polite"></output><p class="panel-note">${route.length?`${points.length.toLocaleString()} recorded GPS points. Drag to pan; use the slider to inspect.`:'Single recorded location.'} Street-map tiles are requested from OpenStreetMap only when loaded.</p><a class="route-external" href="https://www.openstreetmap.org/?mlat=${first.latitude}&mlon=${first.longitude}#map=16/${first.latitude}/${first.longitude}" target="_blank" rel="noopener noreferrer">Open location in OpenStreetMap ↗</a>`;
  const canvas=host.querySelector('.route-canvas'),readout=host.querySelector('output'),slider=host.querySelector('input');
  const fit={center:{...center},zoom}; let width=320,scale=1;
  const draw=()=>{
    width=Math.max(260,canvas.clientWidth);const height=270;scale=256*2**zoom;
    const xy=p=>({x:width/2+(p.x-center.x)*scale,y:height/2+(p.y-center.y)*scale});
    let svg=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Recorded workout ${points.length>1?'route':'location'}"><rect width="100%" height="100%" fill="var(--surface-secondary,#eef1f3)"/>`;
    if(tiles){
      const count=2**zoom,left=center.x*scale-width/2,top=center.y*scale-height/2;
      for(let x=Math.floor(left/256);x<=Math.floor((left+width)/256);x++)for(let y=Math.floor(top/256);y<=Math.floor((top+height)/256);y++){
        if(y<0||y>=count)continue; const wrapped=(x%count+count)%count;
        svg+=`<image href="https://tile.openstreetmap.org/${zoom}/${wrapped}/${y}.png" x="${x*256-left}" y="${y*256-top}" width="256" height="256"/>`;
      }
    }
    let path='',previous;
    const step=Math.max(1,Math.ceil(points.length/5000));
    points.forEach((p,i)=>{
      if(i%step && i!==points.length-1)return;
      const v=xy(projected[i]),gap=previous&&(p.segment!==previous.segment || (p.at&&previous.at&&Date.parse(p.at)-Date.parse(previous.at)>120000));
      path+=`${!previous||gap?'M':'L'}${v.x.toFixed(2)},${v.y.toFixed(2)} `;previous=p;
    });
    const start=xy(projected[0]),end=xy(projected.at(-1)),cursor=xy(projected[selected]);
    svg+=`<path d="${path}" fill="none" stroke="#bd517a" stroke-width="3.5" stroke-linecap="round"/><circle cx="${start.x}" cy="${start.y}" r="5" fill="#287954" stroke="white" stroke-width="2"/><circle cx="${end.x}" cy="${end.y}" r="5" fill="#333" stroke="white" stroke-width="2"/><circle cx="${cursor.x}" cy="${cursor.y}" r="7" fill="#3185d6" stroke="white" stroke-width="2"/><text x="12" y="22" fill="#334">N ↑</text></svg>`;
    canvas.innerHTML=svg+(tiles?'<a class="map-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>':'');
    const p=points[selected];readout.textContent=`${p.latitude.toFixed(6)}, ${p.longitude.toFixed(6)}${p.at?' · '+p.at.slice(11,19)+' UTC':''}${Number.isFinite(p.altitude_m)?' · '+num(p.altitude_m)+' m':''}${Number.isFinite(p.horizontal_accuracy_m)?' · GPS accuracy ±'+num(p.horizontal_accuracy_m)+' m':''}`;
  };
  host.querySelector('.route-toolbar').addEventListener('click',e=>{
    const action=e.target.closest('button')?.dataset.map;
    if(action==='in')zoom=Math.min(18,zoom+1);if(action==='out')zoom=Math.max(2,zoom-1);
    if(action==='fit'){center={...fit.center};zoom=fit.zoom;}
    if(action==='tiles'){tiles=!tiles;e.target.textContent=tiles?'Hide street map':'Load street map';}
    draw();
  });
  slider.addEventListener('input',()=>{selected=Number(slider.value);draw();});
  let drag=null;
  canvas.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,center:{...center}};canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(!drag)return;center={x:drag.center.x-(e.clientX-drag.x)/scale,y:Math.max(0,Math.min(1,drag.center.y-(e.clientY-drag.y)/scale))};draw();});
  canvas.addEventListener('pointerup',()=>drag=null);canvas.addEventListener('pointercancel',()=>drag=null);
  const resize=new ResizeObserver(draw);resize.observe(canvas);draw();return ()=>resize.disconnect();
}
export function mountWorkoutExtras(host,log) {
  const disposers=[renderRoute(host.querySelector('#workout-map'),log)];
  const start=Date.parse(log.start_at);
  for(const [key,id,title,unit,factor] of [['altitude_m','route-elevation','Route elevation','m',1],['speed_m_s','route-speed','Recorded GPS speed','km/h',3.6]]) {
    const all=(log.route?.points||[]).filter(p=>Number.isFinite(p[key])&&Number.isFinite(Date.parse(p.at)));
    const stride=Math.max(1,Math.ceil(all.length/5000));
    const points=all.filter((p,i)=>i%stride===0||i===all.length-1).map(p=>({t:(Date.parse(p.at)-start)/60000,v:p[key]*factor}));
    const el=host.querySelector('#'+id);
    if(!points.length){el.hidden=true;continue;}
    el.insertAdjacentHTML('beforebegin',`<h3>${title}</h3>`);
    disposers.push(lineChart(el,[{key:'apple_health_export',label:title,points,dots:false}],{title,unit,time:false,maxGap:2,start:0,xFormat:t=>`${num(t)} min`}));
  }
  return ()=>disposers.forEach(f=>f());
}
