import test from 'node:test';
import assert from 'node:assert/strict';
import {importAppleHealthXml} from '../src/health-import.js';
import {parseWorkoutRoute,metadataLocation,energyKcal} from '../src/workout-details.js';
const xmlFile=text=>Object.assign(new Blob([text],{type:'application/xml'}),{name:'export.xml'});
test('imports all activities, fields, nested zones, pauses and units without misclosing a workout',async()=>{
  const file=xmlFile(`<HealthData><Workout workoutActivityType="HKWorkoutActivityTypeCycling" startDate="2030-01-01 10:00:00 +0800" endDate="2030-01-01 11:00:00 +0800" duration="55" durationUnit="min" sourceName="Fitness">
    <MetadataEntry key="HKWeatherTemperature" value="86 degF"/><MetadataEntry key="HKWeatherHumidity" value="7600 %"/>
    <MetadataEntry key="FutureField" value="any wording &amp; symbols"/>
    <WorkoutRoute><FileReference path="/workout-routes/route.gpx"/></WorkoutRoute>
    <WorkoutZoneGroup type="heartRate"><WorkoutZone name="Zone 2"/></WorkoutZoneGroup>
    <WorkoutEvent type="HKWorkoutEventTypePause" date="2030-01-01 10:20:00 +0800"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="418.4" unit="kJ"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierBasalEnergyBurned" sum="60" unit="kcal"/>
    <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceCycling" sum="10000" unit="m"/>
    </Workout><Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" startDate="2030-01-02 10:00:00 +0800" endDate="2030-01-02 11:00:00 +0800" duration="60" durationUnit="min"/></HealthData>`);
  const [ride,strength]=await importAppleHealthXml(file);
  assert.equal(ride.workout_type,'cycling');assert.equal(ride.total_energy_kcal,160);assert.equal(ride.temperature_c,30);
  assert.equal(ride.distance_km,10);assert.equal(ride.paused_minutes,5);assert.equal(ride.humidity_percent,undefined);
  assert.equal(ride.health_metadata.FutureField,'any wording & symbols');assert.equal(ride.workout_events.length,1);
  assert.equal(ride.health_details.extra_fields.length,3);assert.match(ride.route_warning,/complete Health ZIP/);
  assert.match(strength.id,/apple-health:strength:/);
});
test('route parser retains coordinates, segments, elevation, timestamps, speed and accuracy',async()=>{
  const r=await parseWorkoutRoute(xmlFile('<gpx><trk><trkseg><trkpt lat="1.3" lon="103.8"><ele>4.5</ele><time>2030-01-01T00:00:00Z</time><extensions><speed>2</speed><hAcc>5</hAcc></extensions></trkpt></trkseg><trkseg><trkpt lat="1.31" lon="103.81"/></trkseg></trk></gpx>'));
  assert.equal(r.points.length,2);assert.equal(r.points[0].speed_m_s,2);assert.equal(r.points[0].horizontal_accuracy_m,5);
  assert.equal(r.points[0].altitude_m,4.5);assert.equal(r.points[1].segment,1);
});
test('single-location metadata is recognised only with explicit, valid coordinate semantics',()=>{
  assert.deepEqual(metadataLocation({HKWorkoutLatitude:'1.3',HKWorkoutLongitude:'103.8'}),{latitude:1.3,longitude:103.8,origin:'workout_metadata'});
  assert.equal(metadataLocation({humidity:'1.3,103.8'}),null);assert.equal(metadataLocation({latitude:'100',longitude:'103'}),null);
  assert.equal(energyKcal('1000','cal'),1);
});
