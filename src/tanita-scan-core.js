const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

function cleanDateText(input = '') {
  return String(input)
    .toUpperCase()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isoDate(year, month, day) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeTanitaDate(input = '') {
  const text = cleanDateText(input);
  let match = text.match(/\b(20\d{2})\s*[-\/.]\s*(\d{1,2})\s*[-\/.]\s*(\d{1,2})\b/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return validDate(year, month, day) ? isoDate(year, month, day) : null;
  }

  match = text.match(/\b(\d{1,2})\s*(?:[\/.\-]|\s)\s*([A-Z]{3,9})\s*(?:[\/.\-]|\s)\s*(20\d{2})\b/);
  if (match) {
    const day = Number(match[1]);
    const month = MONTHS[match[2].slice(0, 3)] || 0;
    const year = Number(match[3]);
    return validDate(year, month, day) ? isoDate(year, month, day) : null;
  }

  match = text.match(/\b(\d{1,2})\s*[-\/.]\s*(\d{1,2})\s*[-\/.]\s*(20\d{2})\b/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    return validDate(year, month, day) ? isoDate(year, month, day) : null;
  }

  return null;
}

function extractDateCandidates(input = '') {
  const text = cleanDateText(input);
  const patterns = [
    /\b20\d{2}\s*[-\/.]\s*\d{1,2}\s*[-\/.]\s*\d{1,2}\b/g,
    /\b\d{1,2}\s*(?:[\/.\-]|\s)\s*[A-Z]{3,9}\s*(?:[\/.\-]|\s)\s*20\d{2}\b/g,
    /\b\d{1,2}\s*[-\/.]\s*\d{1,2}\s*[-\/.]\s*20\d{2}\b/g,
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = normalizeTanitaDate(match[0]);
      if (value && !found.includes(value)) found.push(value);
    }
  }
  return found;
}

function resolveDateFromOcr(topText = '', bottomText = '') {
  const topCandidates = extractDateCandidates(topText);
  const bottomCandidates = extractDateCandidates(bottomText);
  const allCandidates = [...new Set([...topCandidates, ...bottomCandidates])];

  if (allCandidates.length !== 1) {
    return {
      date: null,
      orientation: null,
      needsManual: true,
      topCandidates,
      bottomCandidates,
      reason: allCandidates.length ? 'conflicting' : 'missing',
    };
  }

  const date = allCandidates[0];
  const topHasDate = topCandidates.includes(date);
  const bottomHasDate = bottomCandidates.includes(date);
  const orientation = topHasDate && !bottomHasDate ? 0 : bottomHasDate && !topHasDate ? 180 : null;

  return {
    date,
    orientation,
    needsManual: false,
    topCandidates,
    bottomCandidates,
    reason: null,
  };
}

function tanitaPdfFilename(date, duplicateIndex = 1) {
  const normalized = normalizeTanitaDate(date);
  if (!normalized) return null;
  const suffix = duplicateIndex > 1 ? ` TANITA ${duplicateIndex}.pdf` : ' TANITA.pdf';
  return normalized + suffix;
}

export { cleanDateText, normalizeTanitaDate, extractDateCandidates, resolveDateFromOcr, tanitaPdfFilename };
