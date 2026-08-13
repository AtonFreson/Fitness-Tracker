const MONTHS = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};

const RESULT_KEYS = [
  'weight_kg', 'fat_percent', 'fat_mass_kg', 'ffm_kg', 'muscle_mass_kg',
  'tbw_kg', 'tbw_percent', 'bone_mass_kg', 'bmr_kj', 'bmr_kcal',
  'metabolic_age', 'visceral_fat_rating', 'bmi', 'ideal_body_weight_kg',
  'degree_of_obesity_percent',
];

function cleanText(input = '') {
  return String(input)
    .replace(/\r/g, '\n')
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .toUpperCase();
}

function canonicalizeLabels(input = '') {
  let text = cleanText(input);
  const replacements = [
    [/\bWET\s*GHT\b/g, 'WEIGHT'],
    [/\bWE\s*TIGHT\b/g, 'WEIGHT'],
    [/\bHETGHT\b/g, 'HEIGHT'],
    [/\bHETGHI\b/g, 'HEIGHT'],
    [/\bGENOE?R?\b/g, 'GENDER'],
    [/\bAGT\b/g, 'AGE'],
    [/\bFAI\b/g, 'FAT'],
    [/PHYSTQUE/g, 'PHYSIQUE'],
    [/\bBTOELECTRICAL\b/g, 'BIOELECTRICAL'],
    [/\bBIOELECTRICAL\s+OATA\b/g, 'BIOELECTRICAL DATA'],
    [/\bVISCERAL\s+FAI\b/g, 'VISCERAL FAT'],
    [/\bMUGCLE\b/g, 'MUSCLE'],
    [/\bFT\s*M\b/g, 'FFM'],
    [/\bTRW\b/g, 'TBW'],
    [/\bPGW\b/g, 'TBW'],
    [/\bDES\s*TRABLE\b/g, 'DESIRABLE'],
    [/\bDESTRABLE\b/g, 'DESIRABLE'],
    [/\bPNPUT\b/g, 'INPUT'],
  ];
  for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
  return text;
}

function compact(line) {
  return line.replace(/[^A-Z0-9%+.-]/g, '');
}

function numericTokens(line = '') {
  const repaired = String(line).replace(/(\d)\s*([.,])\s+(\d)/g, '$1$2$3');
  return [...repaired.matchAll(/[-+]?\d+(?:[.,]\d+)?/g)]
    .map((m) => Number(m[0].replace(',', '.')))
    .filter(Number.isFinite);
}

function plausible(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function findSection(text, startPatterns, endPatterns = []) {
  const startIndexes = startPatterns
    .map((p) => text.search(p))
    .filter((x) => x >= 0);
  if (!startIndexes.length) return text;
  const start = Math.min(...startIndexes);
  const tail = text.slice(start);
  const endIndexes = endPatterns
    .map((p) => tail.search(p))
    .filter((x) => x > 0);
  const end = endIndexes.length ? Math.min(...endIndexes) : tail.length;
  return tail.slice(0, end);
}

function findLineValue(section, aliases, { min = -Infinity, max = Infinity, exclude = [], lookahead = 0 } = {}) {
  const lines = section.split('\n').map((x) => x.trim()).filter(Boolean);
  const normalizedAliases = aliases.map((x) => compact(x));
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const c = compact(line);
    if (exclude.some((x) => c.includes(compact(x)))) continue;
    if (!normalizedAliases.some((a) => c.includes(a))) continue;
    const joined = [line, ...lines.slice(i + 1, i + 1 + lookahead)].join(' ');
    const nums = numericTokens(joined);
    const value = nums.find((v) => plausible(v, min, max));
    if (value !== undefined) return value;
  }
  return null;
}

function findTwoLineRange(section, aliases, { min = -Infinity, max = Infinity } = {}) {
  const lines = section.split('\n').map((x) => x.trim()).filter(Boolean);
  const normalizedAliases = aliases.map((x) => compact(x));
  for (let i = 0; i < lines.length; i += 1) {
    const c = compact(lines[i]);
    if (!normalizedAliases.some((a) => c.includes(a))) continue;
    const joined = [lines[i], lines[i + 1] || '', lines[i + 2] || ''].join(' ');
    const nums = numericTokens(joined).filter((v) => plausible(v, min, max));
    if (nums.length >= 2) return [nums[0], nums[1]];
  }
  return null;
}

function filenameDate(sourceName = '') {
  const m = sourceName.match(/(20\d{2})[-_. ](\d{2})[-_. ](\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function normalizeDigitString(s) {
  return s
    .replace(/[OQ]/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/Z/g, '2')
    .replace(/S/g, '5');
}

function parseDateTime(text, sourceName) {
  let date = filenameDate(sourceName);
  const monthNamePattern = /(\d{1,2}|[OQ]\d)\s*[\/.-]\s*([A-Z]{3})\s*[\/.-]\s*([20OQZSLI]{4})/;
  const named = text.match(monthNamePattern);
  if (named && MONTHS[named[2]]) {
    const day = normalizeDigitString(named[1]).padStart(2, '0');
    const year = normalizeDigitString(named[3]);
    if (/^20\d{2}$/.test(year)) date = `${year}-${MONTHS[named[2]]}-${day}`;
  }

  let time = null;
  const tmatches = [...text.matchAll(/\b([0-2OQIL]\d)\s*[:.]\s*([0-5OQIL]\d)\b/g)];
  for (const match of tmatches) {
    const h = Number(normalizeDigitString(match[1]));
    const m = Number(normalizeDigitString(match[2]));
    if (h <= 23 && m <= 59) {
      time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      break;
    }
  }

  return {
    date,
    time,
    measured_at_local: date && time ? `${date}T${time}:00` : date ? `${date}T00:00:00` : null,
  };
}

function parseBmr(resultSection) {
  const lines = resultSection.split('\n').map((x) => x.trim()).filter(Boolean);
  let kj = null;
  let kcal = null;
  let bmrIndex = lines.findIndex((line) => compact(line).includes('BMR'));
  if (bmrIndex < 0) return { kj, kcal };

  const window = lines.slice(bmrIndex, bmrIndex + 4).join(' ');
  const nums = numericTokens(window);
  kj = nums.find((n) => plausible(n, 4000, 10000)) ?? null;
  kcal = nums.find((n) => plausible(n, 1000, 3000)) ?? null;
  return { kj, kcal };
}

function parseBioelectrical(text) {
  const section = findSection(text, [/BIOELECTRICAL/]);
  const lines = section.split('\n').map((x) => x.trim()).filter(Boolean);
  let r = null;
  let x = null;

  for (const line of lines) {
    const c = compact(line);
    const nums = numericTokens(line);
    if (!r && (/^R/.test(c) || c.includes('R')) && nums.length >= 2) {
      const vals = nums.filter((n) => plausible(n, 100, 1500));
      if (vals.length >= 2) r = vals.slice(0, 2);
    }
    if (!x && /^X/.test(c) && nums.length >= 2) {
      const vals = nums.filter((n) => plausible(n, -300, 300));
      if (vals.length >= 2) x = vals.slice(0, 2);
    }
  }

  if (!x && r) {
    const afterR = section.slice(section.search(/\bR\b/));
    const negatives = numericTokens(afterR).filter((n) => n < 0 && plausible(n, -300, 0));
    if (negatives.length >= 2) x = negatives.slice(-2);
  }

  if (!r && !x) return null;
  return {
    '6.25_khz': { r_ohm: r?.[0] ?? null, x_ohm: x?.[0] ?? null },
    '50_khz': { r_ohm: r?.[1] ?? null, x_ohm: x?.[1] ?? null },
  };
}

function parsePhysique(text) {
  const section = findSection(text, [/PHYSIQUE\s+RATING/], [/BIOELECTRICAL/]);
  const m = section.match(/\b(OBESE|STANDARD|ATHLETIC|THIN|MUSCULAR|UNDEREXERCISED)\b/);
  return m ? m[1] : null;
}

function parseTanitaText(rawText, { sourceName = '' } = {}) {
  const text = canonicalizeLabels(rawText);
  const warnings = [];
  const derivedFields = [];
  const dateTime = parseDateTime(text, sourceName);

  const inputSection = findSection(text, [/INPUT/], [/RESULT/, /\n\s*WEIGHT\b/]);
  const resultSection = findSection(text, [/RESULT/, /\n\s*WEIGHT\b/], [/DESIRABLE/, /INDICATOR/, /PHYSIQUE\s+RATING/, /BIOELECTRICAL/]);
  const rangeSection = findSection(text, [/DESIRABLE/], [/INDICATOR/, /PHYSIQUE\s+RATING/, /BIOELECTRICAL/]);

  const input = {
    body_type: /\bSTANDARD\b/.test(inputSection) ? 'STANDARD' : /\bATHLETIC\b/.test(inputSection) ? 'ATHLETIC' : null,
    gender: /\bMALE\b/.test(inputSection) ? 'MALE' : /\bFEMALE\b/.test(inputSection) ? 'FEMALE' : null,
    age: findLineValue(inputSection, ['AGE'], { min: 10, max: 100 }),
    height_cm: findLineValue(inputSection, ['HEIGHT'], { min: 100, max: 230 }),
    clothes_weight_kg: findLineValue(inputSection, ['CLOTHES WEIGHT'], { min: 0, max: 10, lookahead: 2 }),
  };

  const bmr = parseBmr(resultSection);
  const metrics = {
    weight_kg: findLineValue(resultSection, ['WEIGHT'], { min: 30, max: 300, exclude: ['CLOTHES', 'IDEAL'] }),
    fat_percent: findLineValue(resultSection, ['FAT%'], { min: 2, max: 70 }),
    fat_mass_kg: findLineValue(resultSection, ['FAT MASS'], { min: 1, max: 150 }),
    ffm_kg: findLineValue(resultSection, ['FFM'], { min: 20, max: 250 }),
    muscle_mass_kg: findLineValue(resultSection, ['MUSCLE MASS'], { min: 10, max: 200 }),
    tbw_kg: findLineValue(resultSection, ['TBW'], { min: 10, max: 150, exclude: ['%'] }),
    tbw_percent: findLineValue(resultSection, ['TBW%'], { min: 20, max: 80 }),
    bone_mass_kg: findLineValue(resultSection, ['BONE MASS'], { min: 1, max: 10 }),
    bmr_kj: bmr.kj,
    bmr_kcal: bmr.kcal,
    metabolic_age: findLineValue(resultSection, ['METABOLIC AGE'], { min: 10, max: 100 }),
    visceral_fat_rating: findLineValue(resultSection, ['VISCERAL FAT RATING'], { min: 1, max: 60 }),
    bmi: findLineValue(resultSection, ['BMI'], { min: 10, max: 70 }),
    ideal_body_weight_kg: findLineValue(resultSection, ['IDEAL BODY WEIGHT'], { min: 30, max: 250, lookahead: 1 }),
    degree_of_obesity_percent: findLineValue(resultSection, ['DEGREE OF OBESITY'], { min: -80, max: 300, lookahead: 1 }),
  };

  // Cross-check and recover values that OCR commonly drops on thermal receipts.
  // These identities come from the values printed by the DC-360 itself; every recovery is surfaced as a warning.
  if (metrics.ffm_kg == null && metrics.weight_kg && metrics.fat_mass_kg) {
    metrics.ffm_kg = Math.round((metrics.weight_kg - metrics.fat_mass_kg) * 10) / 10;
    derivedFields.push('metrics.ffm_kg');
    warnings.push(`FFM was not readable and was derived as ${metrics.ffm_kg} kg from weight - fat mass.`);
  }

  if (metrics.fat_mass_kg == null && metrics.weight_kg && metrics.ffm_kg) {
    metrics.fat_mass_kg = Math.round((metrics.weight_kg - metrics.ffm_kg) * 10) / 10;
    derivedFields.push('metrics.fat_mass_kg');
    warnings.push(`Fat mass was not readable and was derived as ${metrics.fat_mass_kg} kg from weight - FFM.`);
  }

  if (metrics.weight_kg && metrics.fat_mass_kg) {
    const expectedPercent = Math.round((metrics.fat_mass_kg / metrics.weight_kg * 100) * 10) / 10;
    if (metrics.fat_percent == null) {
      metrics.fat_percent = expectedPercent;
      derivedFields.push('metrics.fat_percent');
      warnings.push(`Fat % was not readable and was derived as ${expectedPercent}% from weight and fat mass.`);
    } else {
      const diff = Math.abs(metrics.fat_percent - expectedPercent);
      if (diff > 0.35 && diff <= 1.0) {
        warnings.push(`Fat % OCR value ${metrics.fat_percent}% conflicted with weight/fat mass; normalized to ${expectedPercent}%.`);
        metrics.fat_percent = expectedPercent;
      } else if (diff > 3) {
        const candidates = [0, 10, 20, 30, 40, 50].map((offset) => metrics.fat_percent + offset);
        const best = candidates.sort((a, b) => Math.abs(a - expectedPercent) - Math.abs(b - expectedPercent))[0];
        if (Math.abs(best - expectedPercent) <= 0.7 && best !== metrics.fat_percent) {
          warnings.push(`Fat % OCR value ${metrics.fat_percent}% conflicted with weight/fat mass; normalized to ${best}%.`);
          metrics.fat_percent = best;
        }
      }
    }
  }

  if (metrics.ffm_kg && metrics.bone_mass_kg) {
    const expectedMuscle = Math.round((metrics.ffm_kg - metrics.bone_mass_kg) * 10) / 10;
    if (metrics.muscle_mass_kg == null) {
      metrics.muscle_mass_kg = expectedMuscle;
      derivedFields.push('metrics.muscle_mass_kg');
      warnings.push(`Muscle mass was not readable and was derived as ${expectedMuscle} kg from FFM - bone mass.`);
    } else if (Math.abs(metrics.muscle_mass_kg - expectedMuscle) > 0.35 && Math.abs(metrics.muscle_mass_kg - expectedMuscle) < 15) {
      warnings.push(`Muscle mass OCR value ${metrics.muscle_mass_kg} kg conflicted with FFM/bone mass; normalized to ${expectedMuscle} kg.`);
      metrics.muscle_mass_kg = expectedMuscle;
    }
  }

  if (metrics.weight_kg && metrics.tbw_percent) {
    const expectedTbw = Math.round((metrics.weight_kg * metrics.tbw_percent / 100) * 10) / 10;
    if (metrics.tbw_kg == null) {
      metrics.tbw_kg = expectedTbw;
      derivedFields.push('metrics.tbw_kg');
      warnings.push(`TBW kg was not readable and was derived as ${expectedTbw} kg from weight and TBW %.`);
    } else if (Math.abs(metrics.tbw_kg - expectedTbw) > 0.6 && Math.abs(metrics.tbw_kg - expectedTbw) < 10) {
      warnings.push(`TBW OCR value ${metrics.tbw_kg} kg conflicted with weight/TBW %; normalized to ${expectedTbw} kg.`);
      metrics.tbw_kg = expectedTbw;
    }
  } else if (metrics.weight_kg && metrics.tbw_kg && metrics.tbw_percent == null) {
    metrics.tbw_percent = Math.round((metrics.tbw_kg / metrics.weight_kg * 100) * 10) / 10;
    derivedFields.push('metrics.tbw_percent');
    warnings.push(`TBW % was not readable and was derived as ${metrics.tbw_percent}% from TBW kg and weight.`);
  }

  if (metrics.bmr_kj && metrics.bmr_kcal) {
    const expected = Math.round(metrics.bmr_kj / 4.184);
    if (Math.abs(metrics.bmr_kcal - expected) > 40 && Math.abs(metrics.bmr_kcal - expected) < 500) {
      warnings.push(`BMR kcal OCR value ${metrics.bmr_kcal} disagreed with ${metrics.bmr_kj} kJ; normalized to ${expected} kcal.`);
      metrics.bmr_kcal = expected;
    }
  } else if (metrics.bmr_kj && metrics.bmr_kcal == null) {
    metrics.bmr_kcal = Math.round(metrics.bmr_kj / 4.184);
    derivedFields.push('metrics.bmr_kcal');
    warnings.push(`BMR kcal was not readable and was derived as ${metrics.bmr_kcal} from the printed kJ value.`);
  } else if (metrics.bmr_kcal && metrics.bmr_kj == null) {
    metrics.bmr_kj = Math.round(metrics.bmr_kcal * 4.184);
    derivedFields.push('metrics.bmr_kj');
    warnings.push(`BMR kJ was not readable and was derived as ${metrics.bmr_kj} from the printed kcal value.`);
  }

  if (metrics.bmi == null && metrics.weight_kg && input.height_cm) {
    metrics.bmi = Math.round((metrics.weight_kg / ((input.height_cm / 100) ** 2)) * 10) / 10;
    derivedFields.push('metrics.bmi');
    warnings.push(`BMI was not readable and was derived as ${metrics.bmi} from weight and height.`);
  }

  if (metrics.degree_of_obesity_percent == null && metrics.weight_kg && metrics.ideal_body_weight_kg) {
    metrics.degree_of_obesity_percent = Math.round(((metrics.weight_kg - metrics.ideal_body_weight_kg) / metrics.ideal_body_weight_kg * 100) * 10) / 10;
    derivedFields.push('metrics.degree_of_obesity_percent');
    warnings.push(`Degree of obesity was not readable and was derived as ${metrics.degree_of_obesity_percent}%.`);
  }

  const fatPercentRange = findTwoLineRange(rangeSection, ['FAT%'], { min: 2, max: 70 });
  const fatMassRange = findTwoLineRange(rangeSection, ['FAT MASS'], { min: 1, max: 150 });
  const reference_ranges = {
    fat_percent: fatPercentRange ? { min: fatPercentRange[0], max: fatPercentRange[1] } : null,
    fat_mass_kg: fatMassRange ? { min: fatMassRange[0], max: fatMassRange[1] } : null,
  };

  if (metrics.weight_kg && input.height_cm && metrics.bmi) {
    const calculated = metrics.weight_kg / ((input.height_cm / 100) ** 2);
    if (Math.abs(calculated - metrics.bmi) > 0.35) {
      warnings.push(`BMI ${metrics.bmi} does not match weight/height (about ${calculated.toFixed(1)}). Review the OCR.`);
    }
  }
  if (metrics.weight_kg && metrics.fat_mass_kg && metrics.ffm_kg) {
    const expectedFfm = metrics.weight_kg - metrics.fat_mass_kg;
    if (Math.abs(expectedFfm - metrics.ffm_kg) > 0.35) {
      warnings.push('Weight, fat mass, and FFM do not reconcile; review those fields.');
    }
  }
  if (metrics.weight_kg && metrics.fat_percent && metrics.fat_mass_kg) {
    const expectedFatMass = metrics.weight_kg * metrics.fat_percent / 100;
    if (Math.abs(expectedFatMass - metrics.fat_mass_kg) > 0.45) {
      warnings.push('Fat %, weight, and fat mass do not reconcile; review those fields.');
    }
  }

  const foundCount = RESULT_KEYS.filter((k) => metrics[k] !== null && metrics[k] !== undefined).length;
  const coreKeys = ['weight_kg', 'fat_percent', 'ffm_kg', 'muscle_mass_kg', 'tbw_kg', 'tbw_percent', 'bone_mass_kg', 'bmr_kcal', 'visceral_fat_rating', 'bmi'];
  const coreFound = coreKeys.filter((k) => metrics[k] !== null && metrics[k] !== undefined).length;
  const completeness = coreFound / coreKeys.length;

  return {
    device: 'TANITA DC-360',
    measured_at_local: dateTime.measured_at_local,
    date: dateTime.date,
    time: dateTime.time,
    input,
    metrics,
    reference_ranges,
    qualitative: { physique_rating: parsePhysique(text) },
    bioelectrical: parseBioelectrical(text),
    extraction: {
      completeness,
      fields_found: foundCount,
      warnings,
      derived_fields: derivedFields,
    },
  };
}

function toBodyCompositionLog(parsed, { sourceName = '', method = 'ocr' } = {}) {
  const stamp = parsed.measured_at_local || parsed.date || `unknown-${Date.now()}`;
  return {
    schema_version: 1,
    id: `tanita:${stamp}`,
    kind: 'body_composition',
    measured_at_local: parsed.measured_at_local,
    source: {
      type: 'tanita_receipt',
      device: parsed.device,
      filename: sourceName || null,
    },
    input: parsed.input,
    metrics: parsed.metrics,
    reference_ranges: parsed.reference_ranges,
    qualitative: parsed.qualitative,
    bioelectrical: parsed.bioelectrical,
    extraction: {
      method,
      completeness: parsed.extraction.completeness,
      warnings: parsed.extraction.warnings,
      derived_fields: parsed.extraction.derived_fields || [],
    },
  };
}

export { parseTanitaText, toBodyCompositionLog, canonicalizeLabels };
