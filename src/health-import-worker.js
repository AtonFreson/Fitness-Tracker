import { importAppleHealthFile } from "./health-import.js?v=7";
import { remoteFile } from "./health-file-bridge.js";

const reads = new Map();
let nextRead = 0;
function readRange(start, end) {
  return new Promise((resolve, reject) => {
    const id = nextRead++;
    reads.set(id, { resolve, reject });
    self.postMessage({ type: "read", id, start, end });
  });
}

self.onmessage = async ({ data }) => {
  if (data.type === "chunk") {
    const request = reads.get(data.id);
    if (!request) return;
    reads.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.bytes);
    return;
  }
  try {
    const logs = await importAppleHealthFile(remoteFile(data.file, readRange), {
      onProgress: (message) => self.postMessage({ type: "progress", message }),
    });
    self.postMessage({ type: "done", logs });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error.message || String(error),
    });
  }
};
