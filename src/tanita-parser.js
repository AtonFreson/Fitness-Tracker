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
    [/\bRE\s*SUL\s*T\b/g, 'RESULT'],
    [/\bBODY\s*[1I|]\s*YPE\b/g, 'BODY TYPE'],
    [/\bSTANDA[KX]D\b/g, 'STANDARD'],
    [/\bMAL\s+E\b/g, 'MALE'],
    [/\bMAL\b/g, 'MALE'],
    [/\bFEMAL\s+E\b/g, 'FEMALE'],
    [/\bWET\s*GHT\b/g, 'WEIGHT'],
    [/\bWE\s*TIGHT\b/g, 'WEIGHT'],
    [/\bHETGHT\b/g, 'HEIGHT'],
    [/\bHETGHI\b/g, 'HEIGHT'],
    [/\bH[ET]?\s*T?GHI\b/g, 'HEIGHT'],
    [/\bGENOE?R?\b/g, 'GENDER'],
    [/\b(?:AGT|ACE|AGF)\b/g, 'AGE'],
    [/\bCLOTH(?:LS|L5|FS|ES)\s+WET?GHT\b/g, 'CLOTHES WEIGHT'],
    [/\bFAI\b/g, 'FAT'],
    [/\bFAT\s+[17]\s*%/g, 'FAT %'],
    [/\b(?:T|1|\[)?BW\s+[17]\s*%/g, 'TBW %'],
    [/\b(?:1BW|\[BW|TRW|PGW)\b/g, 'TBW'],
    [/\bLBW\b/g, 'TBW'],
    [/\bFEM\b/g, 'FFM'],
    [/\bFT\s*M\b/g, 'FFM'],
    [/^\s*[I|]M(?=\s+[0-9BOSG])/gm, 'FFM'],
    [/\bMUGCLE\b/g, 'MUSCLE'],
    [/\bMUSOLE\b/g, 'MUSCLE'],
    [/PHYS\s*TQUE/g, 'PHYSIQUE'],
    [/PHYSTQUE/g, 'PHYSIQUE'],
    [/PHYSITQUE/g, 'PHYSIQUE'],
    [/\bOBE\s+SE\b/g, 'OBESE'],
    [/\bBI0ELECTRICAL\b/g, 'BIOELECTRICAL'],
    [/\bBTOELECTRICAL\b/g, 'BIOELECTRICAL'],
    [/\bK?B\s*[LT]?OELEC\s*TRI\s*CA[IL]\b/g, 'BIOELECTRICAL'],
    [/\bK?B[T]?OELECTRICAL\b/g, 'BIOELECTRICAL'],
    [/\bK?B\s*T?OELECTRICAL\b/g, 'BIOELECTRICAL'],
    [/\bBIOELECTRICAL\s+OATA\b/g, 'BIOELECTRICAL DATA'],
    [/\bVISCERAL\s+FAI\b/g, 'VISCERAL FAT'],
    [/(VISCERAL\s+FAT\s+RATING\s*)[&B](?=\W|$)/g, (_, prefix) => `${prefix}8`],
    [/\bBM\s*[I1|]\b/g, 'BMI'],
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
  const source = String(line).toUpperCase();
  const variants = [];

  function addVariant(value) {
    const normalized = value
      .replace(/[.,]{2,}/g, '.')
      .replace(/\b[OQ]\s*([.,])\s*(\d)/g, '0$1$2')
      .replace(/([.,])\s*[IL|](?=\s*(?:K?G|%|$))/g, (_, separator) => `${separator}1`)
      .replace(/A\s*G(?=[.,]\s*\d)/g, '49')
      .replace(/(\d)\s*([.,])\s+(\d)/g, '$1$2$3')
      .replace(/(\d)\.\s*\/\s*(\d)/g, '$1.$2')
      .replace(/(\d)\s*[\/_]\s*(\d)/g, '$1.$2')
      .replace(/(\d{1,3})-(\d)(?!\d)/g, '$1.$2')
      .replace(/(\d{2,3})\s+(\d)(?=\s*(?:KG|KCAL|KJ|OHM|$))/g, '$1.$2');
    if (!variants.includes(normalized)) variants.push(normalized);
  }

  const withoutLeadingNoise = source.replace(/(^|\s)[BSH](?=\d{2,3}[.,])/g, '$1');

  // Prefer repaired variants over the raw OCR. Otherwise a token such as
  // "35.bkg" is prematurely accepted as 35 instead of trying 35.6/35.8.
  for (const bReplacement of ['6', '8', '5']) {
    const repairedOcr = withoutLeadingNoise
      .replace(/([.,])\s*B(?=\s*(?:K?G|K|%|$))/g, `$1${bReplacement}`)
      .replace(/(?<=[0-9.,])B(?=[0-9.,A-Z]|$)|B(?=[0-9])/g, bReplacement)
      .replace(/(?<=[0-9.,])[OQ](?=[0-9.,A-Z]|$)|[OQ](?=[0-9])/g, '0')
      .replace(/(?<=[0-9.,])[IL|](?=[0-9.,A-Z]|$)|[IL|](?=[0-9])/g, '1')
      .replace(/(?<=[0-9.,])Z(?=[0-9.,A-Z]|$)|Z(?=[0-9])/g, '2')
      .replace(/(?<=[0-9.,])S(?=[0-9.,A-Z]|$)|S(?=[0-9])/g, '5')
      .replace(/(?<=[0-9.,])G(?=[0-9.,A-Z]|$)|G(?=[0-9])/g, '6')
      .replace(/H(?=\d)/g, '5');
    addVariant(repairedOcr);
  }
  addVariant(withoutLeadingNoise);
  addVariant(source);

  const values = [];
  for (const variant of variants) {
    for (const match of variant.matchAll(/[-+]?\d+(?:[.,]\d+)?/g)) {
      const value = Number(match[0].replace(',', '.'));
      if (Number.isFinite(value) && !values.includes(value)) values.push(value);
    }
  }
  return values;
}

function hasAlias(section, aliases) {
  const compactSection = compact(section);
  return aliases.some((alias) => compactSection.includes(compact(alias)));
}

function hasLabeledLine(section, aliases, exclude = []) {
  const normalizedAliases = aliases.map((alias) => compact(alias));
  const normalizedExclude = exclude.map((alias) => compact(alias));
  return section.split('\n').some((line) => {
    const value = compact(line);
    if (normalizedExclude.some((alias) => value.includes(alias))) return false;
    return normalizedAliases.some((alias) => value.includes(alias));
  });
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
    if (nums.length >= 2 && nums[1] > nums[0]) return [nums[0], nums[1]];
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
  const filenameValue = filenameDate(sourceName);
  let date = filenameValue;
  const monthNamePattern = /(\d{1,2}|[OQ]\d)\s*[\/.-]\s*([A-Z]{3})\s*[\/.-]\s*([20OQZSLI]{4})/;
  const named = text.match(monthNamePattern);
  if (!date && named && MONTHS[named[2]]) {
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
    date_source: filenameValue ? 'filename' : date ? 'report' : null,
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
  const kcalCandidates = nums.filter((n) => plausible(n, 1000, 3000));
  if (kj && kcalCandidates.length) {
    const expected = kj / 4.184;
    kcal = [...kcalCandidates].sort((a, b) => Math.abs(a - expected) - Math.abs(b - expected))[0];
  } else {
    // In the DC-360 dot-matrix font, an 8 in a four-digit kcal value is
    // frequently recognized as B (e.g. 15B4). Prefer that direct visual
    // interpretation when the kJ row itself was unreadable.
    const kcalWindow = lines.slice(bmrIndex, bmrIndex + 4).find((line) => /K\s*CAL/i.test(line)) || window;
    const ambiguousEight = kcalWindow.match(/(\d{2})\s*B\s*(\d)/i);
    const repairedEight = ambiguousEight ? Number(`${ambiguousEight[1]}8${ambiguousEight[2]}`) : null;
    kcal = plausible(repairedEight, 1000, 3000) ? repairedEight : (kcalCandidates[0] ?? null);
  }
  return { kj, kcal };
}

function parseBioelectrical(text) {
  if (!/BIOELECTRICAL/.test(text)) return null;
  const section = findSection(text, [/BIOELECTRICAL/]);
  const lines = section.split('\n').map((x) => x.trim()).filter(Boolean);
  let r = null;
  let x = null;
  let rLineIndex = -1;

  const bioValues = (line) => {
    const values = numericTokens(line);
    // A leading 5 in the R row is commonly OCR'd as B. The generic numeric
    // repair intentionally strips a leading B because that is correct for
    // many body-composition fields (e.g. B55.6 -> 55.6). In the impedance row
    // we can disambiguate it using the second frequency value.
    const normalized = String(line).toUpperCase().replace(/[.,]{2,}/g, '.');
    const leadingB = normalized.match(/\bB\s*(\d{2,3}(?:[.,]\d+)?)/);
    if (leadingB) {
      const tail = leadingB[1].replace(',', '.');
      for (const leading of ['5', '6', '8']) {
        const candidate = Number(`${leading}${tail}`);
        if (Number.isFinite(candidate) && !values.includes(candidate)) values.push(candidate);
      }
    }
    return values;
  };

  const resistancePair = (values) => {
    const vals = [...new Set(values.filter((n) => plausible(n, 250, 1000)))];
    let best = null;
    for (const first of vals) {
      for (const second of vals) {
        if (!(first > second)) continue;
        const diff = first - second;
        if (diff < 15 || diff > 220 || first / second > 1.5) continue;
        const score = Math.abs(diff - 65);
        if (!best || score < best.score) best = { score, pair: [first, second] };
      }
    }
    return best?.pair || (vals.length >= 2 ? vals.slice(0, 2) : null);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const c = compact(line);
    const nums = bioValues(line);
    if (!r && /^(?:R|RO|K|KO)/.test(c) && nums.length >= 2) {
      const pair = resistancePair(nums);
      if (pair) {
        r = pair;
        rLineIndex = i;
      }
    }
    if (!x && /^(?:X|XX|XI)/.test(c) && nums.length >= 2) {
      const vals = nums.filter((n) => plausible(Math.abs(n), 3, 300));
      if (vals.length >= 2) x = vals.slice(0, 2).map((n) => -Math.abs(n));
    }
  }

  // On weak thermal OCR the row label R is often read as K/Ko or disappears.
  // The resistance row is still distinctive: two positive 3-digit values,
  // immediately followed by the reactance row.
  if (!r) {
    for (let i = 0; i < lines.length; i += 1) {
      const pair = resistancePair(bioValues(lines[i]));
      if (pair) {
        r = pair;
        rLineIndex = i;
        break;
      }
    }
  }

  if (!x && rLineIndex >= 0) {
    for (let i = rLineIndex + 1; i < Math.min(lines.length, rLineIndex + 4); i += 1) {
      const vals = numericTokens(lines[i]).filter((n) => plausible(Math.abs(n), 3, 200));
      if (vals.length >= 2) {
        x = vals.slice(0, 2).map((n) => -Math.abs(n));
        break;
      }
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
  if (!/PHYSIQUE\s+RATING/.test(text)) return null;
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

  const reviewFields = ['measured_at_local'];
  const addReview = (path, section, aliases, exclude = []) => {
    if (hasLabeledLine(section, aliases, exclude)) reviewFields.push(path);
  };

  addReview('input.body_type', inputSection, ['BODY TYPE']);
  addReview('input.gender', inputSection, ['GENDER']);
  addReview('input.age', inputSection, ['AGE']);
  addReview('input.height_cm', inputSection, ['HEIGHT']);
  addReview('input.clothes_weight_kg', inputSection, ['CLOTHES WEIGHT']);

  addReview('metrics.weight_kg', resultSection, ['WEIGHT'], ['IDEAL', 'CLOTHES']);
  addReview('metrics.fat_percent', resultSection, ['FAT%'], ['FAT MASS']);
  addReview('metrics.fat_mass_kg', resultSection, ['FAT MASS']);
  addReview('metrics.ffm_kg', resultSection, ['FFM']);
  addReview('metrics.muscle_mass_kg', resultSection, ['MUSCLE MASS']);
  addReview('metrics.tbw_kg', resultSection, ['TBW'], ['TBW%']);
  addReview('metrics.tbw_percent', resultSection, ['TBW%']);
  addReview('metrics.bone_mass_kg', resultSection, ['BONE MASS']);
  addReview('metrics.bmr_kj', resultSection, ['BMR']);
  addReview('metrics.bmr_kcal', resultSection, ['BMR']);
  addReview('metrics.metabolic_age', resultSection, ['METABOLIC AGE']);
  addReview('metrics.visceral_fat_rating', resultSection, ['VISCERAL FAT RATING']);
  addReview('metrics.bmi', resultSection, ['BMI']);
  addReview('metrics.ideal_body_weight_kg', resultSection, ['IDEAL BODY WEIGHT']);
  addReview('metrics.degree_of_obesity_percent', resultSection, ['DEGREE OF OBESITY']);

  addReview('reference_ranges.fat_percent.min', rangeSection, ['FAT%']);
  addReview('reference_ranges.fat_percent.max', rangeSection, ['FAT%']);
  addReview('reference_ranges.fat_mass_kg.min', rangeSection, ['FAT MASS']);
  addReview('reference_ranges.fat_mass_kg.max', rangeSection, ['FAT MASS']);

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
  const physiqueRating = parsePhysique(text);
  const bioelectrical = parseBioelectrical(text);
  if (physiqueRating != null) reviewFields.push('qualitative.physique_rating');

  // BIOELECTRICAL DATA is part of the DC-360 receipt layout itself, so these
  // fields are source-guaranteed rather than OCR-guaranteed. Always expose all
  // four in the TANITA review form. If faint printing defeats OCR completely,
  // the user can still type the values visible at the bottom of the receipt.
  reviewFields.push(
    'bioelectrical.6.25_khz.r_ohm',
    'bioelectrical.6.25_khz.x_ohm',
    'bioelectrical.50_khz.r_ohm',
    'bioelectrical.50_khz.x_ohm',
  );

  return {
    device: 'TANITA DC-360',
    measured_at_local: dateTime.measured_at_local,
    date: dateTime.date,
    time: dateTime.time,
    input,
    metrics,
    reference_ranges,
    qualitative: { physique_rating: physiqueRating },
    bioelectrical,
    extraction: {
      completeness,
      fields_found: foundCount,
      warnings,
      derived_fields: derivedFields,
      review_fields: [...new Set(reviewFields)],
      date_source: dateTime.date_source,
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
    indicators: parsed.indicators || null,
    extraction: {
      method,
      completeness: parsed.extraction.completeness,
      warnings: parsed.extraction.warnings,
      derived_fields: parsed.extraction.derived_fields || [],
      corrected_fields: parsed.extraction.corrected_fields || [],
      conflicted_fields: parsed.extraction.conflicted_fields || [],
      candidate_count: parsed.extraction.candidate_count || null,
      review_fields: parsed.extraction.review_fields || ['measured_at_local'],
      date_source: parsed.extraction.date_source || null,
    },
  };
}

function valueAtPath(obj, path) {
  const parts = path.replace('6.25_khz', '6__25_khz').split('.').map((key) => key === '6__25_khz' ? '6.25_khz' : key);
  return parts.reduce((value, key) => value?.[key], obj);
}

function setValueAtPath(obj, path, value) {
  const parts = path.replace('6.25_khz', '6__25_khz').split('.').map((key) => key === '6__25_khz' ? '6.25_khz' : key);
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  cursor[parts.at(-1)] = value;
}

function sameCandidateValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 0.11;
  return String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
}

const CONSENSUS_PATHS = [
  'measured_at_local',
  'date', 'time',
  'input.body_type', 'input.gender', 'input.age', 'input.height_cm', 'input.clothes_weight_kg',
  ...RESULT_KEYS.map((key) => `metrics.${key}`),
  'reference_ranges.fat_percent.min', 'reference_ranges.fat_percent.max',
  'reference_ranges.fat_mass_kg.min', 'reference_ranges.fat_mass_kg.max',
  'qualitative.physique_rating',
  'bioelectrical.6.25_khz.r_ohm', 'bioelectrical.6.25_khz.x_ohm',
  'bioelectrical.50_khz.r_ohm', 'bioelectrical.50_khz.x_ohm',
];

function mergeTanitaParses(parses = []) {
  const candidates = parses.filter(Boolean);
  if (!candidates.length) return null;

  const ranked = [...candidates].sort((a, b) => {
    const as = (a.extraction?.completeness || 0) - (a.extraction?.warnings?.length || 0) * 0.015;
    const bs = (b.extraction?.completeness || 0) - (b.extraction?.warnings?.length || 0) * 0.015;
    return bs - as;
  });
  const merged = JSON.parse(JSON.stringify(ranked[0]));
  const conflictPaths = [];

  for (const path of CONSENSUS_PATHS) {
    const entries = [];
    for (let rank = 0; rank < ranked.length; rank += 1) {
      if (path === 'measured_at_local' && !ranked[rank].time) continue;
      const value = valueAtPath(ranked[rank], path);
      if (value == null || value === '') continue;
      const derived = ranked[rank].extraction?.derived_fields?.includes(path);
      entries.push({ value, rank, derived });
    }
    if (!entries.length) continue;

    const groups = [];
    for (const entry of entries) {
      const group = groups.find((g) => sameCandidateValue(g.value, entry.value));
      if (group) group.entries.push(entry);
      else groups.push({ value: entry.value, entries: [entry] });
    }
    groups.sort((a, b) => {
      const aObserved = a.entries.filter((e) => !e.derived).length;
      const bObserved = b.entries.filter((e) => !e.derived).length;
      if (bObserved !== aObserved) return bObserved - aObserved;
      if (b.entries.length !== a.entries.length) return b.entries.length - a.entries.length;
      return Math.min(...a.entries.map((e) => e.rank)) - Math.min(...b.entries.map((e) => e.rank));
    });
    const observedGroups = groups.filter((group) => group.entries.some((entry) => !entry.derived));
    if (observedGroups.length > 1) conflictPaths.push(path);
    setValueAtPath(merged, path, groups[0].value);
  }

  // Impedance rows have a useful physical ordering across frequencies. When
  // two OCR passes each produce a different-but-plausible R pair, prefer the
  // pair whose 6.25 kHz resistance is modestly above the 50 kHz resistance.
  // This resolves common glyph ambiguity such as B29.4 -> 529.4.
  const rPairs = candidates
    .map((candidate) => [candidate.bioelectrical?.['6.25_khz']?.r_ohm, candidate.bioelectrical?.['50_khz']?.r_ohm])
    .filter(([lowFreq, highFreq]) => lowFreq != null && highFreq != null && lowFreq > highFreq);
  if (rPairs.length) {
    const best = [...rPairs].sort((a, b) => Math.abs((a[0] - a[1]) - 65) - Math.abs((b[0] - b[1]) - 65))[0];
    if (!merged.bioelectrical) merged.bioelectrical = {};
    if (!merged.bioelectrical['6.25_khz']) merged.bioelectrical['6.25_khz'] = {};
    if (!merged.bioelectrical['50_khz']) merged.bioelectrical['50_khz'] = {};
    merged.bioelectrical['6.25_khz'].r_ohm = best[0];
    merged.bioelectrical['50_khz'].r_ohm = best[1];
  }

  const xPairs = candidates
    .map((candidate) => [candidate.bioelectrical?.['6.25_khz']?.x_ohm, candidate.bioelectrical?.['50_khz']?.x_ohm])
    .filter(([lowFreq, highFreq]) => lowFreq != null && highFreq != null);
  if (xPairs.length) {
    const best = [...xPairs].sort((a, b) => {
      const ad = Math.abs(Math.abs(b[1]) - Math.abs(b[0]) - 22);
      const bd = Math.abs(Math.abs(a[1]) - Math.abs(a[0]) - 22);
      return bd - ad;
    })[0];
    if (!merged.bioelectrical) merged.bioelectrical = {};
    if (!merged.bioelectrical['6.25_khz']) merged.bioelectrical['6.25_khz'] = {};
    if (!merged.bioelectrical['50_khz']) merged.bioelectrical['50_khz'] = {};
    merged.bioelectrical['6.25_khz'].x_ohm = best[0];
    merged.bioelectrical['50_khz'].x_ohm = best[1];
  }

  const reviewFields = new Set(['measured_at_local']);
  const candidateDerivedFields = new Set();
  for (const candidate of candidates) {
    for (const field of candidate.extraction?.review_fields || []) reviewFields.add(field);
    for (const field of candidate.extraction?.derived_fields || []) candidateDerivedFields.add(field);
  }

  const warnings = [];
  const correctedFields = new Set();
  const round1 = (value) => Math.round(value * 10) / 10;

  // Re-run the strongest arithmetic identities after candidate voting. This
  // is important when one pass confidently reads a bad digit (for example
  // MUSCLE MASS 92 instead of 52.6) while other fields make the intended
  // value unambiguous.
  if (merged.metrics?.ffm_kg != null && merged.metrics?.bone_mass_kg != null) {
    const expected = round1(merged.metrics.ffm_kg - merged.metrics.bone_mass_kg);
    if (merged.metrics.muscle_mass_kg == null || Math.abs(merged.metrics.muscle_mass_kg - expected) > 0.05) {
      const previous = merged.metrics.muscle_mass_kg;
      merged.metrics.muscle_mass_kg = expected;
      correctedFields.add('metrics.muscle_mass_kg');
      if (previous != null && Math.abs(previous - expected) > 0.5) {
        warnings.push(`Muscle mass OCR was inconsistent (${previous} kg); reconstructed as ${expected} kg from FFM - bone mass.`);
      }
    }
  }

  if (merged.metrics?.weight_kg != null && merged.metrics?.ffm_kg != null && merged.metrics?.fat_mass_kg == null) {
    merged.metrics.fat_mass_kg = round1(merged.metrics.weight_kg - merged.metrics.ffm_kg);
    correctedFields.add('metrics.fat_mass_kg');
  }
  if (merged.metrics?.weight_kg != null && merged.metrics?.fat_mass_kg != null && merged.metrics?.fat_percent == null) {
    merged.metrics.fat_percent = round1(merged.metrics.fat_mass_kg / merged.metrics.weight_kg * 100);
    correctedFields.add('metrics.fat_percent');
  }
  if (merged.metrics?.weight_kg != null && merged.metrics?.tbw_percent != null && merged.metrics?.tbw_kg == null) {
    merged.metrics.tbw_kg = round1(merged.metrics.weight_kg * merged.metrics.tbw_percent / 100);
    correctedFields.add('metrics.tbw_kg');
  }
  if (merged.metrics?.weight_kg != null && merged.metrics?.tbw_kg != null && merged.metrics?.tbw_percent == null) {
    merged.metrics.tbw_percent = round1(merged.metrics.tbw_kg / merged.metrics.weight_kg * 100);
    correctedFields.add('metrics.tbw_percent');
  }
  if (merged.metrics?.bmr_kcal != null && merged.metrics?.bmr_kj == null) {
    merged.metrics.bmr_kj = Math.round(merged.metrics.bmr_kcal * 4.184);
    correctedFields.add('metrics.bmr_kj');
  }
  if (merged.metrics?.bmr_kj != null && merged.metrics?.bmr_kcal == null) {
    merged.metrics.bmr_kcal = Math.round(merged.metrics.bmr_kj / 4.184);
    correctedFields.add('metrics.bmr_kcal');
  }
  if (merged.metrics?.bmi == null && merged.metrics?.weight_kg != null && merged.input?.height_cm != null) {
    merged.metrics.bmi = round1(merged.metrics.weight_kg / ((merged.input.height_cm / 100) ** 2));
    correctedFields.add('metrics.bmi');
  }

  // Final validation is intentionally based only on the merged values. Do not
  // carry warnings produced by a losing OCR candidate into the review screen.
  if (merged.metrics?.weight_kg != null && merged.metrics?.fat_mass_kg != null && merged.metrics?.ffm_kg != null) {
    if (Math.abs(merged.metrics.weight_kg - merged.metrics.fat_mass_kg - merged.metrics.ffm_kg) > 0.35) {
      warnings.push('Weight, fat mass, and FFM do not reconcile; review those fields.');
    }
  }
  if (merged.metrics?.weight_kg != null && merged.metrics?.fat_percent != null && merged.metrics?.fat_mass_kg != null) {
    const expected = merged.metrics.weight_kg * merged.metrics.fat_percent / 100;
    if (Math.abs(expected - merged.metrics.fat_mass_kg) > 0.45) warnings.push('Fat %, weight, and fat mass do not reconcile; review those fields.');
  }
  if (merged.metrics?.weight_kg != null && merged.input?.height_cm != null && merged.metrics?.bmi != null) {
    const expected = merged.metrics.weight_kg / ((merged.input.height_cm / 100) ** 2);
    if (Math.abs(expected - merged.metrics.bmi) > 0.35) warnings.push(`BMI ${merged.metrics.bmi} does not match weight/height (about ${expected.toFixed(1)}). Review the OCR.`);
  }

  const meaningfulConflicts = conflictPaths.filter((path) => path.startsWith('metrics.') || path.startsWith('input.') || path.startsWith('bioelectrical.'));

  const derivedFields = new Set();
  for (const field of candidateDerivedFields) {
    const hasObservedValue = candidates.some((candidate) => {
      const value = valueAtPath(candidate, field);
      return value != null && !(candidate.extraction?.derived_fields || []).includes(field);
    });
    if (!hasObservedValue && valueAtPath(merged, field) != null) derivedFields.add(field);
  }
  for (const field of correctedFields) derivedFields.add(field);

  // If a value exists only because it was recovered mathematically and the
  // label was never printed, keep it in the log but do not ask the user to
  // fill/edit an input that does not exist on this receipt.
  for (const field of derivedFields) {
    const labelPrinted = candidates.some((candidate) => (candidate.extraction?.review_fields || []).includes(field));
    if (!labelPrinted) reviewFields.delete(field);
  }

  const coreKeys = ['weight_kg', 'fat_percent', 'ffm_kg', 'muscle_mass_kg', 'tbw_kg', 'tbw_percent', 'bone_mass_kg', 'bmr_kcal', 'visceral_fat_rating', 'bmi'];
  const coreFound = coreKeys.filter((key) => merged.metrics?.[key] != null).length;
  merged.extraction = {
    ...merged.extraction,
    completeness: coreFound / coreKeys.length,
    fields_found: RESULT_KEYS.filter((key) => merged.metrics?.[key] != null).length,
    warnings,
    derived_fields: [...derivedFields],
    corrected_fields: [...correctedFields],
    conflicted_fields: meaningfulConflicts,
    review_fields: [...reviewFields],
    candidate_count: candidates.length,
  };
  return merged;
}

export { parseTanitaText, toBodyCompositionLog, canonicalizeLabels, mergeTanitaParses };
