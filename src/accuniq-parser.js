function n(value) {
  const x = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(x) ? x : null;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function filenameDate(sourceName = '') {
  const m = String(sourceName).match(/(20\d{2})[-_.](\d{2})[-_.](\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function validDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parseMeasurementDateTime(text, sourceName = '') {
  const fromName = filenameDate(sourceName);
  const m = text.match(/Date\/Time\s+of\s+measurement\s*:\s*(\d{2,4})[.\/-](\d{1,2})[.\/-](\d{1,4})\s+(\d{1,2}):(\d{2})/i);
  if (!m) {
    return {
      date: fromName,
      time: null,
      measured_at_local: fromName ? `${fromName}T00:00:00` : null,
      date_source: fromName ? 'filename' : null,
    };
  }

  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const hh = String(Number(m[4])).padStart(2, '0');
  const mm = String(Number(m[5])).padStart(2, '0');
  const candidates = [];

  // ACCUNIQ Manager commonly prints YY.MM.DD (e.g. 30.01.15 for 2030-01-15).
  if (m[1].length === 2 && m[3].length === 2) {
    if (validDate(2000 + a, b, c)) candidates.push(`${2000 + a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`);
    if (validDate(2000 + c, b, a)) candidates.push(`${2000 + c}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`);
  } else if (m[1].length === 4 && validDate(a, b, c)) {
    candidates.push(`${a}-${String(b).padStart(2, '0')}-${String(c).padStart(2, '0')}`);
  }

  const date = (fromName && candidates.includes(fromName)) ? fromName : candidates[0] || fromName;
  return {
    date,
    time: `${hh}:${mm}`,
    measured_at_local: date ? `${date}T${hh}:${mm}:00` : null,
    date_source: fromName && date === fromName ? 'report+filename' : 'report',
  };
}

function firstNumber(text, pattern) {
  const m = text.match(pattern);
  return m ? n(m[1]) : null;
}

function signedNumber(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return firstNumber(text, new RegExp(`${escaped}\\s*([+-]?\\d+(?:[.,]\\d+)?)\\s*kg`, 'i'));
}

function range(min, max) {
  return min != null && max != null ? { min, max } : null;
}

function bodyCompositionSection(text) {
  const m = String(text).match(/Body\s+Composition\s+Analysis([\s\S]*?)(?:Shows\s+a\s+measurement|Thank\s+you|Selvas\s+Healthcare|$)/i);
  return m ? m[1] : String(text);
}

function solveCompositionValues(text) {
  const section = bodyCompositionSection(text);
  const withoutRanges = section.replace(/\([\d.,]+\s*~\s*[\d.,]+\)/g, ' ');
  const values = [...withoutRanges.matchAll(/(?<![A-Za-z])(-?\d+(?:[.,]\d+)?)(?![A-Za-z])/g)]
    .map((m) => n(m[1]))
    .filter((x) => x != null && x > 0 && x < 300);
  if (values.length < 7 || values.length > 20) return null;

  let best = null;
  const len = values.length;
  for (let iw = 0; iw < len; iw += 1) {
    const weight = values[iw];
    for (let iff = 0; iff < len; iff += 1) {
      if (iff === iw) continue;
      const ffm = values[iff];
      if (!(weight > ffm)) continue;
      for (let ifat = 0; ifat < len; ifat += 1) {
        if (ifat === iw || ifat === iff) continue;
        const fat = values[ifat];
        const e1 = Math.abs(weight - ffm - fat);
        if (e1 > 1.2) continue;
        for (let im = 0; im < len; im += 1) {
          if ([iw, iff, ifat].includes(im)) continue;
          const muscle = values[im];
          if (!(ffm > muscle)) continue;
          for (let imin = 0; imin < len; imin += 1) {
            if ([iw, iff, ifat, im].includes(imin)) continue;
            const minerals = values[imin];
            const e2 = Math.abs(ffm - muscle - minerals);
            if (e2 > 1.0) continue;
            for (let iwater = 0; iwater < len; iwater += 1) {
              if ([iw, iff, ifat, im, imin].includes(iwater)) continue;
              const water = values[iwater];
              if (!(muscle > water)) continue;
              for (let ip = 0; ip < len; ip += 1) {
                if ([iw, iff, ifat, im, imin, iwater].includes(ip)) continue;
                const protein = values[ip];
                if (!(water > protein)) continue;
                const e3 = Math.abs(muscle - water - protein);
                if (e3 > 1.2) continue;
                const maxValue = Math.max(...values);
                const score = e1 + e2 + e3 + (weight === maxValue ? 0 : 2) + (minerals < protein ? 0 : 1);
                if (!best || score < best.score) {
                  best = { score, weight_kg: weight, fat_mass_kg: fat, ffm_kg: ffm, muscle_mass_kg: muscle, minerals_kg: minerals, body_water_l: water, protein_kg: protein };
                }
              }
            }
          }
        }
      }
    }
  }
  return best;
}

function intervalCost(value, r) {
  const width = Math.max(0.1, r.max - r.min);
  const outside = value < r.min ? r.min - value : value > r.max ? value - r.max : 0;
  const center = (r.min + r.max) / 2;
  return outside * 5 + Math.abs(value - center) / width;
}

function assignReferenceRanges(text, values) {
  const section = bodyCompositionSection(text);
  const ranges = [...section.matchAll(/\(([\d.,]+)\s*~\s*([\d.,]+)\)/g)]
    .map((m) => range(n(m[1]), n(m[2])))
    .filter(Boolean);
  const keys = ['body_water_l', 'protein_kg', 'muscle_mass_kg', 'minerals_kg', 'ffm_kg', 'fat_mass_kg', 'weight_kg']
    .filter((key) => values?.[key] != null);
  if (ranges.length < keys.length || keys.length > 8) return {};

  let best = null;
  function walk(index, used, mapping, cost) {
    if (best && cost >= best.cost) return;
    if (index === keys.length) {
      best = { cost, mapping: { ...mapping } };
      return;
    }
    const key = keys[index];
    for (let i = 0; i < ranges.length; i += 1) {
      if (used.has(i)) continue;
      used.add(i);
      mapping[key] = ranges[i];
      walk(index + 1, used, mapping, cost + intervalCost(values[key], ranges[i]));
      used.delete(i);
      delete mapping[key];
    }
  }
  walk(0, new Set(), {}, 0);
  return best?.mapping || {};
}

function parseCompositionTable(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  const pattern = /Body\s+Water\s+L\s*([\d.,]+)\s*\(([\d.,]+)\s*~\s*([\d.,]+)\)\s*([\d.,]+)\s*Protein\s+kg\s*([\d.,]+)\s*\(([\d.,]+)\s*~\s*([\d.,]+)\)\s*([\d.,]+)\s*\(([\d.,]+)\s*~\s*([\d.,]+)\)\s*Minerals\s+kg\s*([\d.,]+)\s*\(([\d.,]+)\s*~\s*([\d.,]+)\)\s*([\d.,]+)\s*\(([\d.,]+)\s*~\s*([\d.,]+)\)\s*Body\s+Fat\s+kg\s*([\d.,]+)\s*\(([\d.,]+)\s*~\s*([\d.,]+)\)\s*([\d.,]+)\s*\(([\d.,]+)\s*~\s*([\d.,]+)\)/i;
  const m = t.match(pattern);
  if (!m) return null;
  return {
    body_water_l: n(m[1]),
    body_water_range: range(n(m[2]), n(m[3])),
    body_water_cumulative_l: n(m[4]),
    protein_kg: n(m[5]),
    protein_range: range(n(m[6]), n(m[7])),
    muscle_mass_kg: n(m[8]),
    muscle_mass_range: range(n(m[9]), n(m[10])),
    minerals_kg: n(m[11]),
    minerals_range: range(n(m[12]), n(m[13])),
    ffm_kg: n(m[14]),
    ffm_range: range(n(m[15]), n(m[16])),
    fat_mass_kg: n(m[17]),
    fat_mass_range: range(n(m[18]), n(m[19])),
    weight_kg: n(m[20]),
    weight_range: range(n(m[21]), n(m[22])),
  };
}

function parseAccuniqText(rawText, { sourceName = '' } = {}) {
  const text = String(rawText || '').replace(/\u00a0/g, ' ');
  const compact = text.replace(/\s+/g, ' ');
  const dateTime = parseMeasurementDateTime(text, sourceName);
  const table = parseCompositionTable(text);
  const solved = table || solveCompositionValues(text);
  const warnings = [];
  const derivedFields = [];

  const metrics = {
    weight_kg: solved?.weight_kg ?? null,
    fat_percent: null,
    fat_mass_kg: solved?.fat_mass_kg ?? firstNumber(compact, /Body\s+Fat\s+kg\s*([\d.,]+)/i),
    ffm_kg: solved?.ffm_kg ?? null,
    muscle_mass_kg: solved?.muscle_mass_kg ?? null,
    body_water_l: solved?.body_water_l ?? firstNumber(compact, /Body\s+Water\s+(?:L\s*)?([\d.,]+)/i),
    protein_kg: solved?.protein_kg ?? firstNumber(compact, /Protein\s+kg\s*([\d.,]+)/i),
    minerals_kg: solved?.minerals_kg ?? firstNumber(compact, /Minerals\s+kg\s*([\d.,]+)/i),
    bmr_kcal: firstNumber(compact, /\bBMR\s*([\d.,]+)\s*kcal/i),
    tdee_kcal: firstNumber(compact, /\bTDE\s*([\d.,]+)\s*kcal/i),
    physical_age: firstNumber(compact, /Physical\s+Age\s*(\d+)\s*Years/i),
  };

  if (metrics.weight_kg == null && metrics.ffm_kg != null && metrics.fat_mass_kg != null) {
    metrics.weight_kg = round1(metrics.ffm_kg + metrics.fat_mass_kg);
    derivedFields.push('metrics.weight_kg');
    warnings.push(`Weight was not readable and was derived as ${metrics.weight_kg} kg from fat-free mass + fat mass.`);
  }
  if (metrics.ffm_kg == null && metrics.weight_kg != null && metrics.fat_mass_kg != null) {
    metrics.ffm_kg = round1(metrics.weight_kg - metrics.fat_mass_kg);
    derivedFields.push('metrics.ffm_kg');
    warnings.push(`Fat-free mass was not readable and was derived as ${metrics.ffm_kg} kg from weight - fat mass.`);
  }
  if (metrics.weight_kg != null && metrics.fat_mass_kg != null) {
    metrics.fat_percent = round1((metrics.fat_mass_kg / metrics.weight_kg) * 100);
    derivedFields.push('metrics.fat_percent');
    warnings.push(`Body-fat percentage is not printed as a numeric value in this ACCUNIQ report; ${metrics.fat_percent}% was derived from fat mass / weight.`);
  }

  const targets = {
    target_weight_kg: firstNumber(compact, /Target\s+Weight\s*([\d.,]+)\s*kg/i),
    weight_control_kg: signedNumber(compact, 'Weight Control'),
    muscle_control_kg: signedNumber(compact, 'Muscle Control'),
    fat_control_kg: signedNumber(compact, 'Fat Control'),
  };

  const analysis = {
    score: firstNumber(text, /\bAnalysis\b[\s\S]{0,180}?\b(\d{1,3})\b/i),
  };

  const bodyType = text.match(/Body\s+Type\s*:\s*([^\r\n]+)/i)?.[1]?.trim() || compact.match(/Body\s+Type\s*:\s*(.+?)(?=\s+Values\b|\s+Body\s+Composition\b|\s+Shows\b|$)/i)?.[1]?.trim() || null;

  if (!solved) warnings.push('The ACCUNIQ composition table was only partially recognized. Review the extracted values before saving.');
  if (metrics.weight_kg != null && metrics.ffm_kg != null && metrics.fat_mass_kg != null) {
    const diff = Math.abs(metrics.weight_kg - (metrics.ffm_kg + metrics.fat_mass_kg));
    if (diff > 0.25) warnings.push('Weight, fat-free mass, and fat mass do not reconcile; review those fields.');
  }

  const coreKeys = ['weight_kg', 'fat_mass_kg', 'ffm_kg', 'muscle_mass_kg', 'body_water_l', 'bmr_kcal'];
  const coreFound = coreKeys.filter((key) => metrics[key] != null).length;

  return {
    device: 'ACCUNIQ',
    measured_at_local: dateTime.measured_at_local,
    date: dateTime.date,
    time: dateTime.time,
    input: {},
    metrics,
    targets,
    analysis,
    reference_ranges: (() => {
      if (table) return {
        body_water_l: table.body_water_range ?? null,
        protein_kg: table.protein_range ?? null,
        muscle_mass_kg: table.muscle_mass_range ?? null,
        minerals_kg: table.minerals_range ?? null,
        ffm_kg: table.ffm_range ?? null,
        fat_mass_kg: table.fat_mass_range ?? null,
        weight_kg: table.weight_range ?? null,
      };
      const assigned = assignReferenceRanges(text, metrics);
      return {
        body_water_l: assigned.body_water_l ?? null,
        protein_kg: assigned.protein_kg ?? null,
        muscle_mass_kg: assigned.muscle_mass_kg ?? null,
        minerals_kg: assigned.minerals_kg ?? null,
        ffm_kg: assigned.ffm_kg ?? null,
        fat_mass_kg: assigned.fat_mass_kg ?? null,
        weight_kg: assigned.weight_kg ?? null,
      };
    })(),
    qualitative: { body_type: bodyType },
    extraction: {
      completeness: coreFound / coreKeys.length,
      warnings,
      derived_fields: derivedFields,
      date_source: dateTime.date_source,
    },
  };
}

function toAccuniqBodyCompositionLog(parsed, { sourceName = '', method = 'pdf-text' } = {}) {
  const stamp = parsed.measured_at_local || parsed.date || `unknown-${Date.now()}`;
  return {
    schema_version: 1,
    id: `accuniq:${stamp}`,
    kind: 'body_composition',
    measured_at_local: parsed.measured_at_local,
    source: {
      type: 'accuniq_report',
      device: parsed.device,
      manufacturer: 'Selvas Healthcare Inc.',
      filename: sourceName || null,
    },
    input: parsed.input,
    metrics: parsed.metrics,
    targets: parsed.targets,
    analysis: parsed.analysis,
    reference_ranges: parsed.reference_ranges,
    qualitative: parsed.qualitative,
    extraction: {
      method,
      completeness: parsed.extraction.completeness,
      warnings: parsed.extraction.warnings,
      derived_fields: parsed.extraction.derived_fields || [],
      date_source: parsed.extraction.date_source || null,
    },
  };
}

export { parseAccuniqText, toAccuniqBodyCompositionLog, parseMeasurementDateTime };
