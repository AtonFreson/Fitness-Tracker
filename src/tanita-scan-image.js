const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

async function waitForOpenCv(timeoutMs = 25000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (window.cv) {
      try {
        const candidate = typeof window.cv.then === 'function' ? await window.cv : window.cv;
        if (candidate && candidate.Mat && candidate.imread) return candidate;
      } catch {}
    }
    await sleep(60);
  }
  throw new Error('The receipt detector could not load. Reload the page and try again.');
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The selected photo could not be opened.'));
    image.src = url;
  });
}

async function imageFileToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('The selected photo has no readable image size.');

    // Keep native camera detail where practical, but cap pathological memory use.
    const maxPixels = 26000000;
    const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function polygonArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function orderQuad(points) {
  const values = points.map((point) => ({
    point,
    sum: point.x + point.y,
    diff: point.x - point.y,
  }));
  const tl = values.reduce((best, item) => item.sum < best.sum ? item : best).point;
  const br = values.reduce((best, item) => item.sum > best.sum ? item : best).point;
  const tr = values.reduce((best, item) => item.diff > best.diff ? item : best).point;
  const bl = values.reduce((best, item) => item.diff < best.diff ? item : best).point;
  return [tl, tr, br, bl];
}

function quadMetrics(points) {
  const [tl, tr, br, bl] = orderQuad(points);
  const width = (distance(tl, tr) + distance(bl, br)) / 2;
  const height = (distance(tl, bl) + distance(tr, br)) / 2;
  return {
    width,
    height,
    shortSide: Math.min(width, height),
    longSide: Math.max(width, height),
    ratio: Math.max(width, height) / Math.max(1, Math.min(width, height)),
    area: polygonArea([tl, tr, br, bl]),
  };
}

function candidateFromPoints(points, method, imageWidth, imageHeight) {
  const ordered = orderQuad(points);
  const metrics = quadMetrics(ordered);
  const imageArea = imageWidth * imageHeight;
  const minImageSide = Math.min(imageWidth, imageHeight);
  const maxImageSide = Math.max(imageWidth, imageHeight);

  if (metrics.area < imageArea * 0.02 || metrics.area > imageArea * 0.65) return null;
  if (metrics.ratio < 2.7 || metrics.ratio > 7.5) return null;
  if (metrics.longSide < maxImageSide * 0.24) return null;
  if (metrics.shortSide < minImageSide * 0.065) return null;

  const center = ordered.reduce(
    (acc, point) => ({ x: acc.x + point.x / 4, y: acc.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  const ratioScore = 1 - Math.min(1, Math.abs(metrics.ratio - 4.45) / 3.2);
  const score = (method === 'paper' ? 3 : 2)
    + ratioScore
    + Math.min(1, metrics.area / (imageArea * 0.12));

  return { points: ordered, method, center, score, ...metrics };
}

function matQuadPoints(mat) {
  const data = mat.data32S;
  const points = [];
  for (let i = 0; i < 8; i += 2) points.push({ x: data[i], y: data[i + 1] });
  return points;
}

function contourCandidates(cv, mask, method, imageWidth, imageHeight, retrievalMode) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const output = [];
  cv.findContours(mask, contours, hierarchy, retrievalMode, cv.CHAIN_APPROX_SIMPLE);

  try {
    const imageArea = imageWidth * imageHeight;
    const epsilons = method === 'paper'
      ? [0.005, 0.008, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05]
      : [0.008, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05];

    for (let i = 0; i < contours.size(); i += 1) {
      const contour = contours.get(i);
      try {
        const area = Math.abs(cv.contourArea(contour, false));
        if (area < imageArea * 0.018 || area > imageArea * 0.8) continue;
        const perimeter = cv.arcLength(contour, true);
        let accepted = null;

        for (const epsilon of epsilons) {
          const approx = new cv.Mat();
          try {
            cv.approxPolyDP(contour, approx, epsilon * perimeter, true);
            if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;
            const candidate = candidateFromPoints(
              matQuadPoints(approx),
              method,
              imageWidth,
              imageHeight,
            );
            if (candidate) {
              accepted = candidate;
              break;
            }
          } finally {
            approx.delete();
          }
        }
        if (accepted) output.push(accepted);
      } finally {
        contour.delete();
      }
    }
  } finally {
    contours.delete();
    hierarchy.delete();
  }
  return output;
}

function boundingBox(candidate) {
  const xs = candidate.points.map((point) => point.x);
  const ys = candidate.points.map((point) => point.y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

function boxIou(a, b) {
  const aa = boundingBox(a);
  const bb = boundingBox(b);
  const left = Math.max(aa.left, bb.left);
  const right = Math.min(aa.right, bb.right);
  const top = Math.max(aa.top, bb.top);
  const bottom = Math.min(aa.bottom, bb.bottom);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  const areaA = (aa.right - aa.left) * (aa.bottom - aa.top);
  const areaB = (bb.right - bb.left) * (bb.bottom - bb.top);
  return intersection / Math.max(1, areaA + areaB - intersection);
}

function dedupeCandidates(candidates) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const candidate of sorted) {
    const duplicate = kept.some((existing) => {
      const centerDistance = distance(candidate.center, existing.center);
      return boxIou(candidate, existing) > 0.42
        || centerDistance < Math.min(candidate.shortSide, existing.shortSide) * 0.55;
    });
    if (!duplicate) kept.push(candidate);
  }
  return kept.sort((a, b) => a.center.x - b.center.x || a.center.y - b.center.y);
}

function detectionCanvas(sourceCanvas, maxDimension = 1600) {
  const scale = Math.min(1, maxDimension / Math.max(sourceCanvas.width, sourceCanvas.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
  canvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
  canvas.getContext('2d', { alpha: false }).drawImage(
    sourceCanvas,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return { canvas, scale };
}

function detectReceiptQuads(sourceCanvas, cv) {
  const detection = detectionCanvas(sourceCanvas);
  const src = cv.imread(detection.canvas);
  const gray = new cv.Mat();
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  const channels = new cv.MatVector();
  const lowSaturation = new cv.Mat();
  const bright = new cv.Mat();
  const otsuMask = new cv.Mat();
  const paperMask = new cv.Mat();
  const paperKernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const edges = new cv.Mat();
  const edgeKernel = cv.Mat.ones(3, 3, cv.CV_8U);
  const edgeCloseKernel = cv.Mat.ones(5, 5, cv.CV_8U);

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.cvtColor(src, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    cv.split(hsv, channels);
    const saturation = channels.get(1);
    const value = channels.get(2);
    try {
      // TANITA paper is bright and nearly neutral. The adaptive brightness
      // floor keeps black-table glare from becoming a false receipt.
      cv.threshold(saturation, lowSaturation, 125, 255, cv.THRESH_BINARY_INV);
      const otsuValue = cv.threshold(
        gray,
        otsuMask,
        0,
        255,
        cv.THRESH_BINARY + cv.THRESH_OTSU,
      );
      const brightnessFloor = Number.isFinite(otsuValue)
        ? clamp(Math.round(otsuValue), 90, 140)
        : 100;
      cv.threshold(value, bright, brightnessFloor, 255, cv.THRESH_BINARY);
      cv.bitwise_and(lowSaturation, bright, paperMask);
      cv.morphologyEx(paperMask, paperMask, cv.MORPH_CLOSE, paperKernel);
    } finally {
      saturation.delete();
      value.delete();
    }

    const candidates = contourCandidates(
      cv,
      paperMask,
      'paper',
      src.cols,
      src.rows,
      cv.RETR_EXTERNAL,
    );

    // Edge geometry is a fallback for colored/uneven backgrounds where the
    // neutral-paper mask is incomplete.
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(gray, edges, 45, 130, 3, false);
    cv.dilate(edges, edges, edgeKernel);
    cv.morphologyEx(
      edges,
      edges,
      cv.MORPH_CLOSE,
      edgeCloseKernel,
      new cv.Point(-1, -1),
      2,
    );
    candidates.push(...contourCandidates(
      cv,
      edges,
      'edge',
      src.cols,
      src.rows,
      cv.RETR_LIST,
    ));

    return dedupeCandidates(candidates).map((candidate) => ({
      ...candidate,
      points: candidate.points.map((point) => ({
        x: point.x / detection.scale,
        y: point.y / detection.scale,
      })),
      center: {
        x: candidate.center.x / detection.scale,
        y: candidate.center.y / detection.scale,
      },
      shortSide: candidate.shortSide / detection.scale,
      longSide: candidate.longSide / detection.scale,
    }));
  } finally {
    src.delete();
    gray.delete();
    rgb.delete();
    hsv.delete();
    channels.delete();
    lowSaturation.delete();
    bright.delete();
    otsuMask.delete();
    paperMask.delete();
    paperKernel.delete();
    edges.delete();
    edgeKernel.delete();
    edgeCloseKernel.delete();
  }
}

function warpReceiptCanvases(sourceCanvas, quads, cv) {
  const source = cv.imread(sourceCanvas);
  const receipts = [];
  try {
    for (const quad of quads) {
      const [tl, tr, br, bl] = orderQuad(quad.points);
      let width = Math.max(distance(tl, tr), distance(bl, br));
      let height = Math.max(distance(tl, bl), distance(tr, br));
      const shortSide = Math.min(width, height);
      const longSide = Math.max(width, height);
      const warpScale = Math.min(1, 1500 / shortSide, 6500 / longSide);
      width = Math.max(2, Math.round(width * warpScale));
      height = Math.max(2, Math.round(height * warpScale));

      const sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
        tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y,
      ]);
      const destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
        0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1,
      ]);
      const transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
      const warped = new cv.Mat();
      const upright = new cv.Mat();
      try {
        cv.warpPerspective(
          source,
          warped,
          transform,
          new cv.Size(width, height),
          cv.INTER_CUBIC,
          cv.BORDER_REPLICATE,
          new cv.Scalar(),
        );
        const canvas = document.createElement('canvas');
        if (width > height) {
          cv.rotate(warped, upright, cv.ROTATE_90_CLOCKWISE);
          cv.imshow(canvas, upright);
        } else {
          cv.imshow(canvas, warped);
        }
        receipts.push(canvas);
      } finally {
        sourcePoints.delete();
        destinationPoints.delete();
        transform.delete();
        warped.delete();
        upright.delete();
      }
    }
  } finally {
    source.delete();
  }
  return receipts;
}

function rotateCanvas180(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d', { alpha: false });
  context.translate(canvas.width, canvas.height);
  context.rotate(Math.PI);
  context.drawImage(source, 0, 0);
  return canvas;
}

function cropCanvas(source, startRatio, endRatio, rotate = false) {
  const top = Math.max(0, Math.floor(source.height * startRatio));
  const bottom = Math.min(source.height, Math.ceil(source.height * endRatio));
  const crop = document.createElement('canvas');
  crop.width = source.width;
  crop.height = Math.max(1, bottom - top);
  crop.getContext('2d', { alpha: false }).drawImage(
    source,
    0,
    top,
    source.width,
    crop.height,
    0,
    0,
    source.width,
    crop.height,
  );
  return rotate ? rotateCanvas180(crop) : crop;
}

function copyCanvas(source, target, maxWidth = source.width) {
  const scale = Math.min(1, maxWidth / source.width);
  target.width = Math.max(1, Math.round(source.width * scale));
  target.height = Math.max(1, Math.round(source.height * scale));
  target.getContext('2d', { alpha: false }).drawImage(
    source,
    0,
    0,
    target.width,
    target.height,
  );
}

export {
  waitForOpenCv,
  imageFileToCanvas,
  detectReceiptQuads,
  warpReceiptCanvases,
  rotateCanvas180,
  cropCanvas,
  copyCanvas,
};
