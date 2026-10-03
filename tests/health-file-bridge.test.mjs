import test from "node:test";
import assert from "node:assert/strict";
import { remoteFile } from "../src/health-file-bridge.js";

test("worker file bridge reads bounded ranges on demand and supports repeatable slices", async () => {
  const data = new Uint8Array(200000).map((_, i) => i % 251),
    reads = [];
  const file = remoteFile(
    { name: "export.xml", size: data.length, type: "application/xml" },
    async (a, b) => {
      reads.push([a, b]);
      return data.slice(a, b).buffer;
    },
  );
  assert.equal(file.slice(-12).size, 12);
  assert.deepEqual(
    new Uint8Array(await file.slice(20, 40).arrayBuffer()),
    data.slice(20, 40),
  );
  const reader = file.stream().getReader();
  await reader.read();
  assert.equal(reads.length, 2);
  assert.equal(reads[1][1] - reads[1][0], 65536);
  await reader.cancel();
  assert.equal(reads.length, 2);
  assert.deepEqual(
    new Uint8Array(await new Response(file.stream()).arrayBuffer()),
    data,
  );
});
