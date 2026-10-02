import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { openAppleHealthExportZip } from "../src/zip-reader.js";

function archive(text, compressed = false) {
  const data = Buffer.from(text);
  const payload = compressed ? deflateRawSync(data) : data;
  const name = Buffer.from("apple_health_export/export.xml");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(compressed ? 8 : 0, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(compressed ? 8 : 0, 10);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + payload.length, 16);
  return new Blob([local, name, payload, central, name, end]);
}

test("ZIP wrapper does not drain the archive ahead of a slow consumer and propagates cancellation", async () => {
  const zip = archive("x".repeat(8_000_000));
  const slice = zip.slice.bind(zip);
  let pulled = 0;
  let cancelled = false;
  zip.slice = (...args) => {
    const part = slice(...args);
    if (part.size === 8_000_000)
      part.stream = () =>
        new ReadableStream({
          pull(controller) {
            pulled++;
            controller.enqueue(new Uint8Array(16384));
          },
          cancel() {
            cancelled = true;
          },
        });
    return part;
  };
  const file = await openAppleHealthExportZip(zip);
  const reader = file.stream().getReader();
  await reader.read();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(pulled <= 3, `Read ${pulled} chunks without demand`);
  await reader.cancel("test finished");
  assert.equal(cancelled, true);
});

test("reads a highly compressed archive twice without holding the expanded file", async () => {
  const text =
    "<HealthData>" + '<Record value="100"/>'.repeat(100_000) + "</HealthData>";
  const file = await openAppleHealthExportZip(archive(text, true));
  for (let pass = 0; pass < 2; pass++) {
    const result = await new Response(file.stream()).text();
    assert.equal(result, text);
  }
});
