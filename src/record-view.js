const FIELD_LABELS = {
  schema_version: 'Schema version',
  id: 'Record ID',
  kind: 'Record type',
  workout_type: 'Workout type',
  start_at: 'Start time',
  end_at: 'End time',
  duration_minutes: 'Duration (minutes)',
  active_energy_kcal: 'Active energy (kcal)',
  measured_at_local: 'Measured at',
  'source.type': 'Source type',
  'source.device': 'Device',
  'source.manufacturer': 'Manufacturer',
  'source.filename': 'Source file',
  'input.body_type': 'Body type',
  'input.gender': 'Gender',
  'input.age': 'Age',
  'input.height_cm': 'Height (cm)',
  'input.clothes_weight_kg': 'Clothes weight (kg)',
  'metrics.weight_kg': 'Weight (kg)',
  'metrics.fat_percent': 'Body fat (%)',
  'metrics.fat_mass_kg': 'Fat mass (kg)',
  'metrics.ffm_kg': 'Fat-free mass (kg)',
  'metrics.muscle_mass_kg': 'Muscle mass (kg)',
  'metrics.tbw_kg': 'Total body water (kg)',
  'metrics.tbw_percent': 'Total body water (%)',
  'metrics.bone_mass_kg': 'Bone mass (kg)',
  'metrics.bmr_kj': 'BMR (kJ)',
  'metrics.bmr_kcal': 'BMR (kcal)',
  'metrics.metabolic_age': 'Metabolic age',
  'metrics.visceral_fat_rating': 'Visceral fat rating',
  'metrics.bmi': 'BMI',
  'metrics.ideal_body_weight_kg': 'Ideal body weight (kg)',
  'metrics.degree_of_obesity_percent': 'Degree of obesity (%)',
  'metrics.body_water_l': 'Body water (L)',
  'metrics.protein_kg': 'Protein (kg)',
  'metrics.minerals_kg': 'Minerals (kg)',
  'metrics.tdee_kcal': 'TDEE (kcal)',
  'metrics.physical_age': 'Physical age',
  'analysis.score': 'Analysis score',
  'targets.target_weight_kg': 'Target weight (kg)',
  'targets.weight_control_kg': 'Weight control (kg)',
  'targets.muscle_control_kg': 'Muscle control (kg)',
  'targets.fat_control_kg': 'Fat control (kg)',
  'qualitative.physique_rating': 'Physique rating',
  'qualitative.body_type': 'Body type',
  'qualitative.evaluation': 'Evaluation',
  'bioelectrical.6.25_khz.r_ohm': 'R 6.25 kHz (Ω)',
  'bioelectrical.50_khz.r_ohm': 'R 50 kHz (Ω)',
  'bioelectrical.6.25_khz.x_ohm': 'X 6.25 kHz (Ω)',
  'bioelectrical.50_khz.x_ohm': 'X 50 kHz (Ω)',
  'indicators.fat_percent.reading': 'Fat % indicator',
  'indicators.bmi.reading': 'BMI indicator',
  'indicators.muscle_mass.reading': 'Muscle mass indicator',
  'indicators.bmr.reading': 'BMR indicator',
  'heart_rate_bpm.average_bpm': 'Average heart rate (bpm)',
  'heart_rate_bpm.min_bpm': 'Minimum heart rate (bpm)',
  'heart_rate_bpm.max_bpm': 'Maximum heart rate (bpm)',
  'heart_rate_bpm.samples': 'Heart-rate samples',
  'extraction.method': 'Extraction method',
  'extraction.completeness': 'Extraction completeness',
  'extraction.date_source': 'Date source',
  'extraction.derived_fields': 'Derived fields',
  'extraction.corrected_fields': 'Corrected fields',
  'extraction.conflicted_fields': 'Conflicted fields',
  'extraction.review_fields': 'Review fields',
  'extraction.warnings': 'Extraction warnings',
};

const ACRONYMS = new Map([
  ['id', 'ID'], ['ffm', 'FFM'], ['tbw', 'TBW'], ['bmi', 'BMI'], ['bmr', 'BMR'], ['tdee', 'TDEE'],
  ['kg', 'kg'], ['kj', 'kJ'], ['kcal', 'kcal'], ['cm', 'cm'], ['bpm', 'bpm'], ['ohm', 'Ω'], ['khz', 'kHz'],
]);

function humanizeSegment(segment = '') {
  return String(segment)
    .replace(/_/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ACRONYMS.get(word.toLowerCase()) || `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function readableFieldLabel(path = '') {
  if (FIELD_LABELS[path]) return FIELD_LABELS[path];
  return String(path).split('.').map(humanizeSegment).join(' · ');
}

function recordEditorPathVisible(path = '') {
  if (!String(path).startsWith('indicators.')) return true;
  return String(path).endsWith('.reading');
}

function dateValue(item) {
  const parsed = Date.parse(item.date || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function compareNumber(a, b, descending) {
  const aOk = Number.isFinite(a);
  const bOk = Number.isFinite(b);
  if (!aOk && !bOk) return 0;
  if (!aOk) return 1;
  if (!bOk) return -1;
  return descending ? b - a : a - b;
}

function sortLogViewItems(items, mode = 'date-desc') {
  const output = [...items];
  const tieNewest = (a, b) => compareNumber(dateValue(a), dateValue(b), true);

  output.sort((a, b) => {
    let result = 0;
    switch (mode) {
      case 'date-asc': result = compareNumber(dateValue(a), dateValue(b), false); break;
      case 'type-asc': result = String(a.type).localeCompare(String(b.type)); break;
      case 'source-asc': result = String(a.source).localeCompare(String(b.source)); break;
      case 'duration-desc': result = compareNumber(a.durationMinutes, b.durationMinutes, true); break;
      case 'duration-asc': result = compareNumber(a.durationMinutes, b.durationMinutes, false); break;
      case 'energy-desc': result = compareNumber(a.activeEnergyKcal, b.activeEnergyKcal, true); break;
      case 'energy-asc': result = compareNumber(a.activeEnergyKcal, b.activeEnergyKcal, false); break;
      case 'weight-desc': result = compareNumber(a.weightKg, b.weightKg, true); break;
      case 'weight-asc': result = compareNumber(a.weightKg, b.weightKg, false); break;
      case 'fat-desc': result = compareNumber(a.fatPercent, b.fatPercent, true); break;
      case 'fat-asc': result = compareNumber(a.fatPercent, b.fatPercent, false); break;
      case 'hr-desc': result = compareNumber(a.averageBpm, b.averageBpm, true); break;
      case 'hr-asc': result = compareNumber(a.averageBpm, b.averageBpm, false); break;
      case 'date-desc':
      default: result = compareNumber(dateValue(a), dateValue(b), true); break;
    }
    return result || tieNewest(a, b);
  });

  return output;
}

function logViewItemVisible(item, filters = {}) {
  if (item.type === 'Body composition' && filters.showBody === false) return false;
  if (item.type === 'Workout' && filters.showWorkout === false) return false;
  if (item.source === 'TANITA DC-360' && filters.showTanita === false) return false;
  if (item.source === 'ACCUNIQ' && filters.showAccuniq === false) return false;
  if (item.source === 'Apple Health' && filters.showAppleHealth === false) return false;

  const search = String(filters.search || '').trim().toLowerCase();
  if (search && !String(item.searchText || '').toLowerCase().includes(search)) return false;
  return true;
}

export { readableFieldLabel, recordEditorPathVisible, sortLogViewItems, logViewItemVisible };
