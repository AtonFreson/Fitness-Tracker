import { importAppleHealthFile } from './health-import.js?v=5';
import { detectUploadKind, labelForSource } from './source-detection.js';

async function importUploadedFile(file, { onStatus, onProgress } = {}) {
  const kind = detectUploadKind(file);
  const progress = onProgress || onStatus;

  if (kind === 'body_composition_report') {
    const { readBodyCompositionReport } = await import('./receipt-reader.js?v=6');
    const result = await readBodyCompositionReport(file, { onStatus: progress });
    return {
      category: 'body_composition',
      detectedSource: result.source,
      sourceLabel: result.sourceLabel,
      result,
      logs: [result.log],
    };
  }

  if (kind === 'apple_health_xml' || kind === 'apple_health_zip') {
    progress?.(`Detected ${labelForSource(kind)} ${kind.endsWith('_zip') ? 'ZIP' : 'XML'}…`);
    return {
      category: 'apple_health',
      detectedSource: 'apple_health',
      sourceLabel: 'Apple Health',
      logs: await importAppleHealthFile(file, { onProgress: progress }),
    };
  }

  throw new Error('Unsupported file. Upload a TANITA/ACCUNIQ PDF or image, Apple Health export.xml, or an Apple Health export ZIP.');
}

export { importUploadedFile };
