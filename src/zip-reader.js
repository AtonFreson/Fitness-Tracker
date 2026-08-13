const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }

function decodeName(bytes, utf8 = true) {
  try {
    return new TextDecoder(utf8 ? 'utf-8' : 'windows-1252').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

async function readCentralDirectory(file) {
  const tailSize = Math.min(file.size, 65557);
  const tailOffset = file.size - tailSize;
  const tail = new Uint8Array(await file.slice(tailOffset).arrayBuffer());
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (u32(tailView, i) === EOCD_SIGNATURE) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This ZIP file has no readable central directory.');

  const entries = u16(tailView, eocd + 10);
  const centralSize = u32(tailView, eocd + 12);
  const centralOffset = u32(tailView, eocd + 16);
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('This Apple Health archive uses ZIP64, which this browser importer cannot read yet. Exporting again usually produces a standard ZIP.');
  }

  const bytes = new Uint8Array(await file.slice(centralOffset, centralOffset + centralSize).arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [];
  let p = 0;
  while (p + 46 <= bytes.length && out.length < entries) {
    if (u32(view, p) !== CENTRAL_SIGNATURE) break;
    const flags = u16(view, p + 8);
    const method = u16(view, p + 10);
    const compressedSize = u32(view, p + 20);
    const uncompressedSize = u32(view, p + 24);
    const nameLength = u16(view, p + 28);
    const extraLength = u16(view, p + 30);
    const commentLength = u16(view, p + 32);
    const localOffset = u32(view, p + 42);
    const nameBytes = bytes.slice(p + 46, p + 46 + nameLength);
    const name = decodeName(nameBytes, Boolean(flags & 0x0800));
    out.push({ name, flags, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

async function compressedPayload(file, entry) {
  const header = new Uint8Array(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length < 30 || u32(view, 0) !== LOCAL_SIGNATURE) throw new Error(`Invalid ZIP entry header for ${entry.name}.`);
  const nameLength = u16(view, 26);
  const extraLength = u16(view, 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  return file.slice(start, start + entry.compressedSize);
}

async function fflateRawStream(blob) {
  const mod = await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js');
  return new ReadableStream({
    async start(controller) {
      const inflator = new mod.Inflate((chunk, final) => {
        if (chunk?.length) controller.enqueue(chunk);
        if (final) controller.close();
      });
      const reader = blob.stream().getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          inflator.push(value || new Uint8Array(), done);
          if (done) break;
        }
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

async function streamEntry(file, entry) {
  const payload = await compressedPayload(file, entry);
  if (entry.method === 0) return payload.stream();
  if (entry.method !== 8) throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}.`);

  if (typeof DecompressionStream !== 'undefined') {
    try {
      return payload.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    } catch {
      // Fall through to fflate for browsers that expose DecompressionStream without deflate-raw support.
    }
  }
  return fflateRawStream(payload);
}

async function openAppleHealthExportZip(file) {
  const entries = await readCentralDirectory(file);
  const candidates = entries.filter((entry) => /(^|\/)export\.xml$/i.test(entry.name) && !entry.name.endsWith('/'));
  if (!candidates.length) {
    throw new Error('No export.xml was found in this ZIP. Choose the ZIP created by Health → Export All Health Data.');
  }
  candidates.sort((a, b) => {
    const aPreferred = /(^|\/)apple_health_export\/export\.xml$/i.test(a.name) ? 0 : 1;
    const bPreferred = /(^|\/)apple_health_export\/export\.xml$/i.test(b.name) ? 0 : 1;
    return aPreferred - bPreferred || a.name.length - b.name.length;
  });
  const entry = candidates[0];
  return {
    name: entry.name,
    type: 'application/xml',
    size: entry.uncompressedSize,
    stream: () => new ReadableStream({
      async start(controller) {
        try {
          const stream = await streamEntry(file, entry);
          const reader = stream.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    }),
  };
}

export { readCentralDirectory, openAppleHealthExportZip };
