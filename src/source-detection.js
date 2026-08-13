function lowerName(fileOrName = '') {
  return String(typeof fileOrName === 'string' ? fileOrName : fileOrName?.name || '').toLowerCase();
}

function detectUploadKind(file) {
  const name = lowerName(file);
  const type = String(file?.type || '').toLowerCase();

  if (name.endsWith('.zip') || type === 'application/zip' || type === 'application/x-zip-compressed') {
    return 'apple_health_zip';
  }
  if (name.endsWith('.xml') || type.includes('xml')) return 'apple_health_xml';
  if (name.endsWith('.pdf') || type === 'application/pdf') return 'body_composition_report';
  if (type.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif)$/i.test(name)) return 'body_composition_report';
  return 'unknown';
}

function detectBodyCompositionSource(text = '', fileName = '') {
  const haystack = `${text}\n${fileName}`;
  if (/\bACCUNIQ\b|Selvas\s+Healthcare|Comprehensive\s+Evaluation|ACCUNIQ\s+Manager/i.test(haystack)) {
    return 'accuniq';
  }
  if (/\bTANITA\b|DC\s*[-–]?\s*360|VISCERAL\s+FAT\s+RATING|BIOELECTRICAL\s+DATA/i.test(haystack)) {
    return 'tanita';
  }
  return 'unknown';
}

function labelForSource(source) {
  if (source === 'accuniq') return 'ACCUNIQ';
  if (source === 'tanita') return 'TANITA DC-360';
  if (source === 'apple_health_zip' || source === 'apple_health_xml' || source === 'apple_health') return 'Apple Health';
  return 'Unknown';
}

export { detectUploadKind, detectBodyCompositionSource, labelForSource };
