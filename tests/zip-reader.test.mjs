import test from 'node:test';
import assert from 'node:assert/strict';
import { openAppleHealthExportZip, readCentralDirectory } from '../src/zip-reader.js';

function le16(n) { return [n & 255, (n >>> 8) & 255]; }
function le32(n) { return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]; }
function bytes(...parts) {
  const arrays = parts.map((p) => p instanceof Uint8Array ? p : Uint8Array.from(p));
  const out = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function makeStoredZip(name, text) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const data = enc.encode(text);
  const local = bytes(
    le32(0x04034b50), le16(20), le16(0x0800), le16(0), le16(0), le16(0),
    le32(0), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0), nameBytes, data,
  );
  const central = bytes(
    le32(0x02014b50), le16(20), le16(20), le16(0x0800), le16(0), le16(0), le16(0),
    le32(0), le32(data.length), le32(data.length), le16(nameBytes.length), le16(0), le16(0),
    le16(0), le16(0), le32(0), le32(0), nameBytes,
  );
  const eocd = bytes(
    le32(0x06054b50), le16(0), le16(0), le16(1), le16(1),
    le32(central.length), le32(local.length), le16(0),
  );
  const blob = new Blob([local, central, eocd], { type: 'application/zip' });
  Object.defineProperty(blob, 'name', { value: 'export.zip' });
  return blob;
}

test('finds apple_health_export/export.xml without unzipping the whole archive', async () => {
  const xml = '<HealthData locale="en_US"></HealthData>';
  const zip = makeStoredZip('apple_health_export/export.xml', xml);
  const entries = await readCentralDirectory(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'apple_health_export/export.xml');
  const file = await openAppleHealthExportZip(zip);
  assert.equal(file.name, 'apple_health_export/export.xml');
  const actual = await new Response(file.stream()).text();
  assert.equal(actual, xml);
});
