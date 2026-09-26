const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Points always follow the displayed receipt: TL, TR, BR, BL.
function receiptGeometry(points) {
  const [tl, tr, br, bl] = points;
  const horizontal = Math.max(distance(tl, tr), distance(bl, br))
    > Math.max(distance(tl, bl), distance(tr, br));
  const ordered = horizontal ? [bl, tl, tr, br] : points;
  return {
    points: ordered.map((point) => ({ ...point })),
    quarterTurns: horizontal ? 1 : 0,
  };
}

function rotateGeometry180(receipt) {
  const [tl, tr, br, bl] = receipt.points;
  receipt.points = [br, bl, tl, tr];
  receipt.quarterTurns = (receipt.quarterTurns + 2) % 4;
}

function sourceToView(point, width, height, turns) {
  if (turns === 1) return { x: height - point.y, y: point.x };
  if (turns === 2) return { x: width - point.x, y: height - point.y };
  if (turns === 3) return { x: point.y, y: width - point.x };
  return { ...point };
}

function viewToSource(point, width, height, turns) {
  if (turns === 1) return { x: point.y, y: height - point.x };
  if (turns === 2) return { x: width - point.x, y: height - point.y };
  if (turns === 3) return { x: width - point.y, y: point.x };
  return { ...point };
}

function reviewFrame(points, width, height, turns, margin = 0.1) {
  const view = points.map((point) => sourceToView(point, width, height, turns));
  const left = Math.min(...view.map((point) => point.x));
  const top = Math.min(...view.map((point) => point.y));
  const receiptWidth = Math.max(...view.map((point) => point.x)) - left;
  const receiptHeight = Math.max(...view.map((point) => point.y)) - top;
  return {
    left: left - receiptWidth * margin,
    top: top - receiptHeight * margin,
    width: receiptWidth * (1 + margin * 2),
    height: receiptHeight * (1 + margin * 2),
  };
}

function validQuad(points) {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % 4];
    const c = points[(i + 2) % 4];
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y) || distance(a, b) < 8) return false;
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1 || (sign && Math.sign(cross) !== sign)) return false;
    sign = Math.sign(cross);
  }
  return true;
}

function nudgeCorner(points, index, dx, dy, turns, width, height) {
  const next = points.map((point) => ({ ...point }));
  const view = sourceToView(next[index], width, height, turns);
  const moved = viewToSource({ x: view.x + dx, y: view.y + dy }, width, height, turns);
  if (moved.x < 0 || moved.y < 0 || moved.x > width - 1 || moved.y > height - 1) return null;
  next[index] = moved;
  return validQuad(next) ? next : null;
}

export {
  receiptGeometry, rotateGeometry180, sourceToView, viewToSource,
  reviewFrame, validQuad, nudgeCorner,
};
