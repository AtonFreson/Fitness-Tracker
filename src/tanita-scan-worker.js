/* TANITA scanner worker: all OpenCV/WASM work stays off the UI thread. */
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function postLog(event, data = null) {
  postMessage({
    type: 'log',
    event,
    data,
    workerElapsedMs: Math.round(performance.now() - workerStarted),
  });
}

function postError(error, context = null) {
  postMessage({
    type: 'worker-error',
    message: String(error?.message || error || 'Unknown worker error'),
    stack: String(error?.stack || ''),
    context,
  });
}

const workerStarted = performance.now();
let cvInstance = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function unwrapCv(candidate) {
  if (!candidate) return null;
  if (typeof candidate.then === 'function') {
    const resolved = await candidate;
    return resolved?.Mat ? resolved : null;
  }
  return candidate?.Mat ? candidate : null;
}

async function initializeOpenCv(url) {
  postLog('worker-opencv-import-start', { url });
  importScripts(url);
  postLog('worker-opencv-script-evaluated', {
    url,
    cvType: typeof self.cv,
    thenable: Boolean(self.cv && typeof self.cv.then === 'function'),
  });

  const started = performance.now();
  while (performance.now() - started < 30000) {
    const candidate = await unwrapCv(self.cv);
    if (candidate?.Mat && candidate?.matFromImageData) {
      cvInstance = candidate;
      self.cv = candidate;
      postLog('worker-opencv-ready', {
        url,
        elapsedMs: Math.round(performance.now() - started),
        hasMatFromImageData: Boolean(candidate.matFromImageData),
      });
      return;
    }
    await sleep(50);
  }
  throw new Error('OpenCV runtime did not initialize in worker.');
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

function matFromCanvas(cv, canvas, context) {
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  return cv.matFromImageData(image);
}

function detectRoughQuads(fullCanvas, fullContext, cv, maxDimension = 1600) {
  const scale = Math.min(1, maxDimension / Math.max(fullCanvas.width, fullCanvas.height));
  const width = Math.max(1, Math.round(fullCanvas.width * scale));
  const height = Math.max(1, Math.round(fullCanvas.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  context.drawImage(fullCanvas, 0, 0, width, height);

  const src = matFromCanvas(cv, canvas, context);
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
        x: point.x / scale,
        y: point.y / scale,
      })),
      center: {
        x: candidate.center.x / scale,
        y: candidate.center.y / scale,
      },
      width: candidate.width / scale,
      height: candidate.height / scale,
      shortSide: candidate.shortSide / scale,
      longSide: candidate.longSide / scale,
      area: candidate.area / (scale * scale),
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

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sampleGray(image, x, y) {
  const maxX = image.width - 1;
  const maxY = image.height - 1;
  const px = clamp(x, 0, maxX);
  const py = clamp(y, 0, maxY);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(maxX, x0 + 1);
  const y1 = Math.min(maxY, y0 + 1);
  const fx = px - x0;
  const fy = py - y0;
  const data = image.data;
  const luminance = (ix, iy) => {
    const offset = (iy * image.width + ix) * 4;
    return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
  };
  const top = luminance(x0, y0) * (1 - fx) + luminance(x1, y0) * fx;
  const bottom = luminance(x0, y1) * (1 - fx) + luminance(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

function fitWeightedLine(samples, roughDirection) {
  if (samples.length < 20) return null;
  const strengths = samples.map((sample) => sample.strength);
  const typicalStrength = Math.max(1, median(strengths));
  let robustWeights = samples.map(() => 1);
  let line = null;

  for (let iteration = 0; iteration < 4; iteration += 1) {
    let totalWeight = 0;
    let meanX = 0;
    let meanY = 0;

    for (let i = 0; i < samples.length; i += 1) {
      const baseWeight = clamp(samples[i].strength / typicalStrength, 0.35, 3);
      const weight = baseWeight * robustWeights[i];
      totalWeight += weight;
      meanX += samples[i].x * weight;
      meanY += samples[i].y * weight;
    }
    if (totalWeight < 1e-6) return null;
    meanX /= totalWeight;
    meanY /= totalWeight;

    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const baseWeight = clamp(samples[i].strength / typicalStrength, 0.35, 3);
      const weight = baseWeight * robustWeights[i];
      const dx = samples[i].x - meanX;
      const dy = samples[i].y - meanY;
      sxx += weight * dx * dx;
      sxy += weight * dx * dy;
      syy += weight * dy * dy;
    }

    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let direction = { x: Math.cos(angle), y: Math.sin(angle) };
    if (direction.x * roughDirection.x + direction.y * roughDirection.y < 0) {
      direction = { x: -direction.x, y: -direction.y };
    }

    line = { point: { x: meanX, y: meanY }, direction };
    const residuals = samples.map((sample) => Math.abs(
      (sample.x - meanX) * direction.y - (sample.y - meanY) * direction.x,
    ));
    const middleResidual = median(residuals);
    const deviations = residuals.map((value) => Math.abs(value - middleResidual));
    const sigma = Math.max(0.45, 1.4826 * median(deviations));
    const cutoff = Math.max(1.25, middleResidual + 3.25 * sigma);

    robustWeights = residuals.map((value) => {
      const normalized = value / cutoff;
      if (normalized >= 1) return 0;
      const remaining = 1 - normalized * normalized;
      return remaining * remaining;
    });
  }

  if (!line) return null;
  const alignment = Math.abs(
    line.direction.x * roughDirection.x + line.direction.y * roughDirection.y,
  );
  if (alignment < Math.cos(12 * Math.PI / 180)) return null;

  const residuals = samples.map((sample) => Math.abs(
    (sample.x - line.point.x) * line.direction.y
      - (sample.y - line.point.y) * line.direction.x,
  ));
  line.residual = median(residuals);
  line.support = residuals.filter((value) => value <= Math.max(1.5, line.residual * 2.5)).length
    / samples.length;
  line.score = line.support * typicalStrength * alignment / (1 + line.residual);
  return line;
}

function lineFromPoints(a, b) {
  const length = Math.max(1e-6, distance(a, b));
  return {
    point: { x: a.x, y: a.y },
    direction: { x: (b.x - a.x) / length, y: (b.y - a.y) / length },
  };
}

function refineEdge(context, canvas, a, b, shortSide) {
  const length = distance(a, b);
  if (length < 40) return null;
  const direction = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
  const normal = { x: -direction.y, y: direction.x };
  const band = clamp(shortSide * 0.03, 7, 36);
  const margin = band + 4;
  const left = clamp(Math.floor(Math.min(a.x, b.x) - margin), 0, canvas.width - 1);
  const top = clamp(Math.floor(Math.min(a.y, b.y) - margin), 0, canvas.height - 1);
  const right = clamp(Math.ceil(Math.max(a.x, b.x) + margin), left + 1, canvas.width);
  const bottom = clamp(Math.ceil(Math.max(a.y, b.y) + margin), top + 1, canvas.height);
  const image = context.getImageData(left, top, right - left, bottom - top);

  const sampleCount = clamp(Math.round(length / 4), 90, 700);
  const positive = [];
  const negative = [];
  const minOffset = -Math.floor(band);
  const maxOffset = Math.floor(band);

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const t = 0.07 + (sampleIndex / Math.max(1, sampleCount - 1)) * 0.86;
    const base = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const profile = [];

    for (let offset = minOffset; offset <= maxOffset; offset += 1) {
      const minus = sampleGray(
        image,
        base.x + normal.x * (offset - 1) - left,
        base.y + normal.y * (offset - 1) - top,
      );
      const plus = sampleGray(
        image,
        base.x + normal.x * (offset + 1) - left,
        base.y + normal.y * (offset + 1) - top,
      );
      profile.push(plus - minus);
    }

    for (const polarity of [1, -1]) {
      let bestIndex = -1;
      let bestStrength = -Infinity;
      for (let i = 1; i < profile.length - 1; i += 1) {
        const strength = profile[i] * polarity;
        if (strength > bestStrength) {
          bestStrength = strength;
          bestIndex = i;
        }
      }
      if (bestIndex < 1 || bestStrength < 6) continue;

      const previous = profile[bestIndex - 1] * polarity;
      const center = profile[bestIndex] * polarity;
      const next = profile[bestIndex + 1] * polarity;
      const denominator = previous - 2 * center + next;
      const delta = Math.abs(denominator) > 1e-6
        ? clamp(0.5 * (previous - next) / denominator, -0.75, 0.75)
        : 0;
      const offset = minOffset + bestIndex + delta;
      const point = {
        x: base.x + normal.x * offset,
        y: base.y + normal.y * offset,
        strength: bestStrength,
      };
      (polarity > 0 ? positive : negative).push(point);
    }
  }

  const candidates = [
    fitWeightedLine(positive, direction),
    fitWeightedLine(negative, direction),
  ].filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((aLine, bLine) => bLine.score - aLine.score);
  const best = candidates[0];
  if (best.support < 0.45 || best.residual > Math.max(2.2, band * 0.22)) return null;
  return best;
}

function lineIntersection(first, second) {
  const denominator = first.direction.x * second.direction.y
    - first.direction.y * second.direction.x;
  if (Math.abs(denominator) < 1e-5) return null;
  const dx = second.point.x - first.point.x;
  const dy = second.point.y - first.point.y;
  const t = (dx * second.direction.y - dy * second.direction.x) / denominator;
  return {
    x: first.point.x + first.direction.x * t,
    y: first.point.y + first.direction.y * t,
  };
}

function isConvexQuad(points) {
  let sign = 0;
  for (let i = 0; i < 4; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % 4];
    const c = points[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) return false;
    const current = Math.sign(cross);
    if (!sign) sign = current;
    if (current !== sign) return false;
  }
  return true;
}

function refineQuad(context, canvas, candidate) {
  const rough = orderQuad(candidate.points);
  const metrics = quadMetrics(rough);
  const lines = [];
  let refinedEdges = 0;

  for (let i = 0; i < 4; i += 1) {
    const a = rough[i];
    const b = rough[(i + 1) % 4];
    const refined = refineEdge(context, canvas, a, b, metrics.shortSide);
    if (refined) refinedEdges += 1;
    lines.push(refined || lineFromPoints(a, b));
  }

  if (refinedEdges < 2) return candidate;
  const points = [
    lineIntersection(lines[3], lines[0]),
    lineIntersection(lines[0], lines[1]),
    lineIntersection(lines[1], lines[2]),
    lineIntersection(lines[2], lines[3]),
  ];
  if (points.some((point) => !point)) return candidate;

  const maxMove = Math.max(12, metrics.shortSide * 0.07);
  if (points.some((point, index) => distance(point, rough[index]) > maxMove)) return candidate;
  if (!isConvexQuad(points)) return candidate;

  const refinedMetrics = quadMetrics(points);
  const areaRatio = refinedMetrics.area / Math.max(1, metrics.area);
  if (areaRatio < 0.78 || areaRatio > 1.22) return candidate;
  if (refinedMetrics.ratio < 2.6 || refinedMetrics.ratio > 7.7) return candidate;

  const center = points.reduce(
    (acc, point) => ({ x: acc.x + point.x / 4, y: acc.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  return {
    ...candidate,
    points,
    center,
    ...refinedMetrics,
    refinedEdges,
    subpixelRefined: true,
  };
}

async function matToBitmap(mat) {
  const bytes = new Uint8ClampedArray(mat.data);
  const imageData = new ImageData(bytes, mat.cols, mat.rows);
  return createImageBitmap(imageData);
}

async function warpReceipt(fullCanvas, quad, cv) {
  const ordered = orderQuad(quad.points);
  const [tl, tr, br, bl] = ordered;
  let outputWidth = Math.max(distance(tl, tr), distance(bl, br));
  let outputHeight = Math.max(distance(tl, bl), distance(tr, br));
  const shortSide = Math.min(outputWidth, outputHeight);
  const longSide = Math.max(outputWidth, outputHeight);
  const outputScale = Math.min(1, 1500 / shortSide, 6500 / longSide);
  outputWidth = Math.max(2, Math.round(outputWidth * outputScale));
  outputHeight = Math.max(2, Math.round(outputHeight * outputScale));

  const margin = Math.max(8, Math.round(shortSide * 0.04));
  const minX = clamp(Math.floor(Math.min(...ordered.map((p) => p.x)) - margin), 0, fullCanvas.width - 1);
  const minY = clamp(Math.floor(Math.min(...ordered.map((p) => p.y)) - margin), 0, fullCanvas.height - 1);
  const maxX = clamp(Math.ceil(Math.max(...ordered.map((p) => p.x)) + margin), minX + 1, fullCanvas.width);
  const maxY = clamp(Math.ceil(Math.max(...ordered.map((p) => p.y)) + margin), minY + 1, fullCanvas.height);

  const cropWidth = maxX - minX;
  const cropHeight = maxY - minY;
  const cropCanvas = new OffscreenCanvas(cropWidth, cropHeight);
  const cropContext = cropCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  cropContext.drawImage(
    fullCanvas,
    minX, minY, cropWidth, cropHeight,
    0, 0, cropWidth, cropHeight,
  );

  const source = cv.matFromImageData(cropContext.getImageData(0, 0, cropWidth, cropHeight));
  const sourcePoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    tl.x - minX, tl.y - minY,
    tr.x - minX, tr.y - minY,
    br.x - minX, br.y - minY,
    bl.x - minX, bl.y - minY,
  ]);
  const destinationPoints = cv.matFromArray(4, 1, cv.CV_32FC2, [
    0, 0,
    outputWidth - 1, 0,
    outputWidth - 1, outputHeight - 1,
    0, outputHeight - 1,
  ]);
  const transform = cv.getPerspectiveTransform(sourcePoints, destinationPoints);
  const warped = new cv.Mat();
  const upright = new cv.Mat();

  try {
    cv.warpPerspective(
      source,
      warped,
      transform,
      new cv.Size(outputWidth, outputHeight),
      cv.INTER_CUBIC,
      cv.BORDER_REPLICATE,
      new cv.Scalar(),
    );

    if (outputWidth > outputHeight) {
      cv.rotate(warped, upright, cv.ROTATE_90_CLOCKWISE);
      return await matToBitmap(upright);
    }
    return await matToBitmap(warped);
  } finally {
    source.delete();
    sourcePoints.delete();
    destinationPoints.delete();
    transform.delete();
    warped.delete();
    upright.delete();
  }
}

async function scanImage(bitmap) {
  if (!cvInstance) throw new Error('OpenCV worker is not initialized.');
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('This browser does not provide OffscreenCanvas to workers.');
  }

  const started = performance.now();
  const fullCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = fullCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!context) throw new Error('Could not create worker canvas context.');

  context.fillStyle = '#fff';
  context.fillRect(0, 0, fullCanvas.width, fullCanvas.height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  postLog('worker-image-ready', {
    width: fullCanvas.width,
    height: fullCanvas.height,
    pixels: fullCanvas.width * fullCanvas.height,
  });

  const roughStarted = performance.now();
  const rough = detectRoughQuads(fullCanvas, context, cvInstance);
  postLog('worker-rough-quads', {
    count: rough.length,
    elapsedMs: Math.round(performance.now() - roughStarted),
  });
  if (!rough.length) return { quads: [], bitmaps: [] };

  const refineStarted = performance.now();
  const quads = rough.map((quad) => refineQuad(context, fullCanvas, quad));
  postLog('worker-refined-quads', {
    count: quads.length,
    elapsedMs: Math.round(performance.now() - refineStarted),
    refined: quads.map((q) => ({
      subpixelRefined: Boolean(q.subpixelRefined),
      refinedEdges: q.refinedEdges || 0,
    })),
  });

  const bitmaps = [];
  for (let i = 0; i < quads.length; i += 1) {
    const warpStarted = performance.now();
    bitmaps.push(await warpReceipt(fullCanvas, quads[i], cvInstance));
    postLog('worker-receipt-warped', {
      index: i,
      elapsedMs: Math.round(performance.now() - warpStarted),
      width: bitmaps.at(-1).width,
      height: bitmaps.at(-1).height,
    });
  }

  postLog('worker-scan-complete', {
    receiptCount: quads.length,
    elapsedMs: Math.round(performance.now() - started),
  });
  return { quads, bitmaps };
}

self.onmessage = async (event) => {
  const message = event.data || {};
  try {
    if (message.type === 'init') {
      await initializeOpenCv(message.url);
      postMessage({ type: 'ready' });
      return;
    }

    if (message.type === 'scan') {
      const result = await scanImage(message.bitmap);
      postMessage({
        type: 'scan-result',
        requestId: message.requestId,
        quads: result.quads,
        receipts: result.bitmaps,
      }, result.bitmaps);
    }
  } catch (error) {
    postError(error, { type: message.type, requestId: message.requestId || null });
  }
};
