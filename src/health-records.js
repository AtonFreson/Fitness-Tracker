// Health exports can omit older samples. Preserve the already imported history.
export function mergeHealthWorkouts(existing, incoming) {
  const previous = new Map(
    existing
      .filter((log) => log.kind === "workout")
      .map((log) => [log.id, log]),
  );
  return incoming.map((log) => {
    const old = previous.get(log.id);
    if (!old) return log;
    const a = old.heart_rate_bpm;
    const b = log.heart_rate_bpm;
    const retained = {...old,...log};
    for(const key of ['active_energy_kcal','basal_energy_kcal','distance_km','route','location','average_mets','temperature_c','elevation_ascended_m','indoor','time_zone','humidity_percent']) {
      if(log[key] == null && old[key] != null) retained[key]=old[key];
    }
    if(!log.route?.points?.length && old.route?.points?.length)retained.route=old.route;
    retained.health_metadata={...old.health_metadata,...log.health_metadata};
    for(const key of ['workout_events','workout_statistics']) if(!log[key]?.length && old[key]?.length)retained[key]=old[key];
    if(Number.isFinite(retained.active_energy_kcal)&&Number.isFinite(retained.basal_energy_kcal))retained.total_energy_kcal=retained.active_energy_kcal+retained.basal_energy_kcal;
    if (!a && !b) return retained;
    const samples = new Map();
    for (const sample of [
      ...(Array.isArray(a?.samples) ? a.samples : []),
      ...(Array.isArray(b?.samples) ? b.samples : []),
    ]) {
      const key = `${Date.parse(sample.at)}|${Date.parse(sample.end_at || sample.at)}|${sample.bpm}`;
      samples.set(key, sample);
    }
    return {
      ...retained,
      active_energy_kcal:
        log.active_energy_kcal ?? old.active_energy_kcal ?? null,
      heart_rate_bpm: {
        average_bpm: b?.average_bpm ?? a?.average_bpm ?? null,
        min_bpm: b?.min_bpm ?? a?.min_bpm ?? null,
        max_bpm: b?.max_bpm ?? a?.max_bpm ?? null,
        samples: [...samples.values()].sort(
          (x, y) => Date.parse(x.at) - Date.parse(y.at) || x.bpm - y.bpm,
        ),
      },
    };
  });
}
