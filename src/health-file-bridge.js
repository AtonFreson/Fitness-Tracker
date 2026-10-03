// Keep selected-file I/O in its originating context. Only bounded byte ranges cross the worker boundary.
export function remoteFile(meta, readRange) {
  function part(start, end) {
    const size = end - start;
    return {
      size,
      name: meta.name,
      type: meta.type,
      slice(a = 0, b = size) {
        const clamp = (n) => Math.max(0, Math.min(size, n < 0 ? size + n : n));
        const from = clamp(a),
          to = Math.max(from, clamp(b));
        return part(start + from, start + to);
      },
      arrayBuffer: () => readRange(start, end),
      stream() {
        let offset = start,
          cancelled = false;
        return new ReadableStream(
          {
            async pull(controller) {
              if (offset >= end) {
                controller.close();
                return;
              }
              try {
                const next = Math.min(offset + 65536, end);
                const bytes = await readRange(offset, next);
                offset = next;
                if (!cancelled) controller.enqueue(new Uint8Array(bytes));
              } catch (error) {
                if (!cancelled) controller.error(error);
              }
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        );
      },
    };
  }
  return part(0, meta.size);
}
