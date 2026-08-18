const FIELD_SPECS = [
  {
    source: 'tanita',
    path: 'input.body_type',
    label: 'Body type',
    pattern: /\bBODY\s+TYPE\s*[:=\-]?\s*(.{1,80}?)(?=\s+(?:GENDER\b|AGE\b|HEIGHT\b|CLOTHES\s+WEIGHT\b|RESULT\b|---)|$)/gi,
  },
  {
    source: 'tanita',
    path: 'input.gender',
    label: 'Gender',
    pattern: /\bGENDER\s*[:=\-]?\s*(.{1,50}?)(?=\s+(?:AGE\b|HEIGHT\b|CLOTHES\s+WEIGHT\b|RESULT\b|---)|$)/gi,
  },
  {
    source: 'tanita',
    path: 'qualitative.physique_rating',
    label: 'Physique rating',
    pattern: /\bPHYSIQUE\s+RATING\s*[:=\-]?\s*(.{1,80}?)(?=\s+(?:BIOELECTRICAL(?:\s+DATA)?\b|6(?:\.25)?\s*K?HZ\b|---)|$)/gi,
  },
  {
    source: 'accuniq',
    path: 'qualitative.body_type',
    label: 'Body type',
    pattern: /\bBODY\s+TYPE\s*:\s*(.{1,100}?)(?=\s+(?:VALUES\b|BODY\s+COMPOSITION\b|COMPREHENSIVE\s+EVALUATION\b|SHOWS\b|ANALYSIS\b|---)|$)/gi,
  },
];

function sourceKind(sourceHint = '') {
  const value = String(sourceHint).toLowerCase();
  if (value.includes('tanita')) return 'tanita';
  if (value.includes('accuniq')) return 'accuniq';
  return 'unknown';
}

function flattenedText(text = '') {
  return String(text)
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCandidate(value = '') {
  const candidate = String(value)
    .replace(/^[:=\-\s]+/, '')
    .replace(/[|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[,:;\-\s]+$/, '')
    .trim();
  if (!candidate || candidate.length > 120 || /GOOGLE\s+VISION|EXTRACTION\s+DIAGNOSTICS/i.test(candidate)) return '';
  return candidate;
}

function bestMatch(text, pattern) {
  const matches = [];
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const candidate = cleanCandidate(match[1]);
    if (candidate) matches.push(candidate);
  }
  return matches.sort((a, b) => {
    const wordDiff = b.split(/\s+/).length - a.split(/\s+/).length;
    return wordDiff || b.length - a.length;
  })[0] || '';
}

function recoverTextFields(rawText, sourceHint = '') {
  const source = sourceKind(sourceHint);
  const text = flattenedText(rawText);
  if (!text) return [];

  return FIELD_SPECS
    .filter((spec) => source === 'unknown' || spec.source === source)
    .map((spec) => ({ ...spec, value: bestMatch(text, spec.pattern) }))
    .filter((spec) => spec.value);
}

function shouldUseRecoveredText(currentValue, recoveredValue) {
  const current = cleanCandidate(currentValue);
  const recovered = cleanCandidate(recoveredValue);
  if (!recovered) return false;
  if (!current) return true;

  const a = current.toUpperCase();
  const b = recovered.toUpperCase();
  if (a === b) return false;
  if (b.length <= a.length) return false;

  const currentWords = a.split(/\s+/).filter(Boolean).length;
  const recoveredWords = b.split(/\s+/).filter(Boolean).length;
  return b.includes(a) || recoveredWords > currentWords;
}

export { recoverTextFields, shouldUseRecoveredText, cleanCandidate };
