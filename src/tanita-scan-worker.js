/* TANITA scanner worker.
 * Pure JavaScript implementation so iOS never needs to initialize OpenCV/WASM.
 * The worker performs paper segmentation, robust four-line fitting, full-resolution
 * sub-pixel edge refinement and a projective four-corner warp.
 */
const workerStarted = performance.now();
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

function quantile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const position = clamp(fraction, 0, 1) * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  const mix = position - low;
  return sorted[low] * (1 - mix) + sorted[high] * mix;
}

function median(values) {
  return quantile(values, 0.5);
}

function otsuThreshold(histogram, count) {
  let total = 0;
  for (let i = 0; i < 256; i += 1) total += i * histogram[i];

  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let bestThreshold = 110;

  for (let threshold = 0; threshold < 256; threshold += 1) {
    backgroundWeight += histogram[threshold];
    if (!backgroundWeight) continue;

    const foregroundWeight = count - backgroundWeight;
    if (!foregroundWeight) break;

    backgroundSum += threshold * histogram[threshold];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (total - backgroundSum) / foregroundWeight;
    const difference = backgroundMean - foregroundMean;
    const variance = backgroundWeight * foregroundWeight * difference * difference;

    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = threshold;
    }
  }
  return bestThreshold;
}

function buildPaperMask(image) {
  const { data, width, height } = image;
  const pixelCount = width * height;
  const gray = new Uint8Array(pixelCount);
  const chroma = new Uint8Array(pixelCount);
  const histogram = new Uint32Array(256);

  for (let pixel = 0, offset = 0; pixel < pixelCount; pixel += 1, offset += 4) {
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const luminance = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    gray[pixel] = luminance;
    chroma[pixel] = maximum - minimum;
    histogram[luminance] += 1;
  }

  const otsu = otsuThreshold(histogram, pixelCount);
  const brightnessFloor = clamp(Math.round(otsu), 90, 150);
  const mask = new Uint8Array(pixelCount);

  for (let i = 0; i < pixelCount; i += 1) {
    // White thermal paper is bright and low-chroma. This rejects the yellow
    // lamp reflection in the reference photos while preserving warm paper.
    if (gray[i] >= brightnessFloor && chroma[i] <= 65) mask[i] = 1;
  }

  return { mask, brightnessFloor, otsu };
}

function robustLineFit(xs, ys) {
  if (xs.length < 4 || ys.length !== xs.length) return null;
  let weights = new Float64Array(xs.length);
  weights.fill(1);
  let slope = 0;
  let intercept = 0;

  for (let iteration = 0; iteration < 5; iteration += 1) {
    let sumWeight = 0;
    let meanX = 0;
    let meanY = 0;

    for (let i = 0; i < xs.length; i += 1) {
      const weight = weights[i];
      sumWeight += weight;
      meanX += weight * xs[i];
      meanY += weight * ys[i];
    }
    if (sumWeight < 1e-8) return null;
    meanX /= sumWeight;
    meanY /= sumWeight;

    let denominator = 0;
    let numerator = 0;
    for (let i = 0; i < xs.length; i += 1) {
      const dx = xs[i] - meanX;
      denominator += weights[i] * dx * dx;
      numerator += weights[i] * dx * (ys[i] - meanY);
    }
    if (denominator < 1e-8) return null;

    slope = numerator / denominator;
    intercept = meanY - slope * meanX;

    const residuals = new Array(xs.length);
    for (let i = 0; i < xs.length; i += 1) {
      residuals[i] = Math.abs(ys[i] - (slope * xs[i] + intercept));
    }

    const middle = median(residuals);
    const deviations = residuals.map((value) => Math.abs(value - middle));
    const sigma = Math.max(0.5, 1.4826 * median(deviations));
    const cutoff = Math.max(1.5, middle + 3 * sigma);

    weights = Float64Array.from(residuals, (value) => {
      const normalized = value / cutoff;
      if (normalized >= 1) return 0;
      const remaining = 1 - normalized * normalized;
      return remaining * remaining;
    });
  }

  const residuals = xs.map((x, i) => Math.abs(ys[i] - (slope * x + intercept)));
  return {
    slope,
    intercept,
    residual: median(residuals),
  };
}

function fitComponentQuad(queue, size, imageWidth, imageHeight) {
  const sampleCount = Math.min(size, 60000);
  if (sampleCount < 250) return null;

  const xs = new Array(sampleCount);
  const ys = new Array(sampleCount);

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const queueIndex = Math.min(size - 1, Math.floor(sample * size / sampleCount));
    const index = queue[queueIndex];
    xs[sample] = index % imageWidth;
    ys[sample] = Math.floor(index / imageWidth);
  }

  const centerX = median(xs);
  const centerY = median(ys);

  let meanX = 0;
  let meanY = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    meanX += xs[i];
    meanY += ys[i];
  }
  meanX /= sampleCount;
  meanY /= sampleCount;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  let angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let ux = Math.cos(angle);
  let uy = Math.sin(angle);

  // The eigenvector above can represent either covariance axis. Pick the
  // direction with the larger variance as the receipt's long axis.
  const varianceAlong = ux * ux * sxx + 2 * ux * uy * sxy + uy * uy * syy;
  const vxCandidate = -uy;
  const vyCandidate = ux;
  const varianceAcross = vxCandidate * vxCandidate * sxx
    + 2 * vxCandidate * vyCandidate * sxy
    + vyCandidate * vyCandidate * syy;
  if (varianceAcross > varianceAlong) {
    const oldUx = ux;
    ux = -uy;
    uy = oldUx;
  }
  if (uy < 0) {
    ux = -ux;
    uy = -uy;
  }

  const vx = -uy;
  const vy = ux;
  const projectedU = new Array(sampleCount);
  const projectedV = new Array(sampleCount);

  for (let i = 0; i < sampleCount; i += 1) {
    const dx = xs[i] - centerX;
    const dy = ys[i] - centerY;
    projectedU[i] = dx * ux + dy * uy;
    projectedV[i] = dx * vx + dy * vy;
  }

  const uLow = quantile(projectedU, 0.02);
  const uHigh = quantile(projectedU, 0.98);
  if (!(uHigh > uLow)) return null;

  const longBins = 64;
  const vBins = Array.from({ length: longBins }, () => []);
  for (let i = 0; i < sampleCount; i += 1) {
    const normalized = (projectedU[i] - uLow) / (uHigh - uLow);
    const bin = Math.floor(normalized * longBins);
    if (bin >= 0 && bin < longBins) vBins[bin].push(projectedV[i]);
  }

  const uCenters = [];
  const leftEdges = [];
  const rightEdges = [];

  for (let bin = 0; bin < longBins; bin += 1) {
    const values = vBins[bin];
    if (values.length < 25) continue;

    const p15 = quantile(values, 0.15);
    const p50 = quantile(values, 0.50);
    const p85 = quantile(values, 0.85);
    const estimatedWidth = (p85 - p15) / 0.70;
    if (!(estimatedWidth > 3)) continue;

    uCenters.push(uLow + (uHigh - uLow) * (bin + 0.5) / longBins);
    leftEdges.push(p50 - estimatedWidth / 2);
    rightEdges.push(p50 + estimatedWidth / 2);
  }

  const leftLine = robustLineFit(uCenters, leftEdges);
  const rightLine = robustLineFit(uCenters, rightEdges);
  if (!leftLine || !rightLine) return null;

  const insideU = [];
  const insideV = [];
  const widths = [];

  for (let i = 0; i < sampleCount; i += 1) {
    const u = projectedU[i];
    const v = projectedV[i];
    const first = leftLine.slope * u + leftLine.intercept;
    const second = rightLine.slope * u + rightLine.intercept;
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    widths.push(high - low);
    if (v >= low && v <= high) {
      insideU.push(u);
      insideV.push(v);
    }
  }

  if (insideU.length < sampleCount * 0.35) return null;
  const typicalWidth = median(widths.filter((value) => value > 0));
  if (!(typicalWidth > 5)) return null;

  const vLow = quantile(insideV, 0.03);
  const vHigh = quantile(insideV, 0.97);
  if (!(vHigh > vLow)) return null;

  const acrossBins = 24;
  const uBins = Array.from({ length: acrossBins }, () => []);
  for (let i = 0; i < insideU.length; i += 1) {
    const normalized = (insideV[i] - vLow) / (vHigh - vLow);
    const bin = Math.floor(normalized * acrossBins);
    if (bin >= 0 && bin < acrossBins) uBins[bin].push(insideU[i]);
  }

  const vCenters = [];
  const startEdges = [];
  const endEdges = [];

  for (let bin = 0; bin < acrossBins; bin += 1) {
    const values = uBins[bin];
    if (values.length < 25) continue;

    const p05 = quantile(values, 0.05);
    const p50 = quantile(values, 0.50);
    const p95 = quantile(values, 0.95);
    const estimatedLength = (p95 - p05) / 0.90;
    if (!(estimatedLength > typicalWidth * 2)) continue;

    vCenters.push(vLow + (vHigh - vLow) * (bin + 0.5) / acrossBins);
    startEdges.push(p50 - estimatedLength / 2);
    endEdges.push(p50 + estimatedLength / 2);
  }

  const startLine = robustLineFit(vCenters, startEdges);
  const endLine = robustLineFit(vCenters, endEdges);
  if (!startLine || !endLine) return null;

  function intersectSideAndEnd(sideLine, endFit) {
    // side: v = a*u + b
    // end:  u = c*v + d
    const denominator = 1 - endFit.slope * sideLine.slope;
    if (Math.abs(denominator) < 1e-6) return null;

    const u = (endFit.slope * sideLine.intercept + endFit.intercept) / denominator;
    const v = sideLine.slope * u + sideLine.intercept;
    return {
      x: centerX + ux * u + vx * v,
      y: centerY + uy * u + vy * v,
    };
  }

  const points = [
    intersectSideAndEnd(leftLine, startLine),
    intersectSideAndEnd(rightLine, startLine),
    intersectSideAndEnd(rightLine, endLine),
    intersectSideAndEnd(leftLine, endLine),
  ];
  if (points.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return null;
  }

  const metrics = quadMetrics(points);
  const imageArea = imageWidth * imageHeight;
  if (metrics.area < imageArea * 0.015 || metrics.area > imageArea * 0.55) return null;
  if (metrics.ratio < 2.7 || metrics.ratio > 7.5) return null;

  const center = points.reduce(
    (acc, point) => ({ x: acc.x + point.x / 4, y: acc.y + point.y / 4 }),
    { x: 0, y: 0 },
  );

  return {
    points: orderQuad(points),
    center,
    method: 'paper-strip',
    ...metrics,
  };
}

function detectPaperQuads(image) {
  const started = performance.now();
  const { mask, brightnessFloor, otsu } = buildPaperMask(image);
  const width = image.width;
  const height = image.height;
  const pixelCount = width * height;
  const queue = new Int32Array(pixelCount);
  const candidates = [];

  const minimumArea = Math.max(1200, Math.round(pixelCount * 0.012));
  const maximumArea = Math.round(pixelCount * 0.65);

  for (let seed = 0; seed < pixelCount; seed += 1) {
    if (!mask[seed]) continue;

    let head = 0;
    let tail = 1;
    queue[0] = seed;
    mask[seed] = 0;

    let minX = seed % width;
    let maxX = minX;
    let minY = Math.floor(seed / width);
    let maxY = minY;

    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = Math.floor(index / width);

      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(height - 1, y + 1);
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);

      for (let ny = y0; ny <= y1; ny += 1) {
        let neighbor = ny * width + x0;
        for (let nx = x0; nx <= x1; nx += 1, neighbor += 1) {
          if (!mask[neighbor]) continue;
          mask[neighbor] = 0;
          queue[tail++] = neighbor;
        }
      }
    }

    if (tail < minimumArea || tail > maximumArea) continue;

    const bboxWidth = maxX - minX + 1;
    const bboxHeight = maxY - minY + 1;
    const longSide = Math.max(bboxWidth, bboxHeight);
    const shortSide = Math.min(bboxWidth, bboxHeight);
    if (longSide < Math.max(width, height) * 0.20) continue;
    if (shortSide < Math.min(width, height) * 0.05) continue;

    const candidate = fitComponentQuad(queue, tail, width, height);
    if (candidate) candidates.push(candidate);
  }

  // Multiple threshold islands can occasionally describe the same receipt.
  candidates.sort((a, b) => b.area - a.area);
  const kept = [];
  for (const candidate of candidates) {
    const duplicate = kept.some((existing) => {
      const centerDistance = distance(candidate.center, existing.center);
      return centerDistance < Math.min(candidate.shortSide, existing.shortSide) * 0.65;
    });
    if (!duplicate) kept.push(candidate);
  }

  kept.sort((a, b) => a.center.x - b.center.x || a.center.y - b.center.y);
  postLog('worker-paper-components-fitted', {
    otsu,
    brightnessFloor,
    candidateCount: candidates.length,
    keptCount: kept.length,
    elapsedMs: Math.round(performance.now() - started),
  });
  return kept;
}

function fitWeightedGeometricLine(samples, roughDirection) {
  if (samples.length < 20) return null;
  const strengths = samples.map((sample) => sample.strength);
  const typicalStrength = Math.max(1, median(strengths));
  let robustWeights = new Float64Array(samples.length);
  robustWeights.fill(1);
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

    let xx = 0;
    let xy = 0;
    let yy = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const baseWeight = clamp(samples[i].strength / typicalStrength, 0.35, 3);
      const weight = baseWeight * robustWeights[i];
      const dx = samples[i].x - meanX;
      const dy = samples[i].y - meanY;
      xx += weight * dx * dx;
      xy += weight * dx * dy;
      yy += weight * dy * dy;
    }

    const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
    let direction = { x: Math.cos(angle), y: Math.sin(angle) };
    if (direction.x * roughDirection.x + direction.y * roughDirection.y < 0) {
      direction = { x: -direction.x, y: -direction.y };
    }

    line = { point: { x: meanX, y: meanY }, direction };
    const residuals = samples.map((sample) => Math.abs(
      (sample.x - meanX) * direction.y - (sample.y - meanY) * direction.x,
    ));
    const middle = median(residuals);
    const deviations = residuals.map((value) => Math.abs(value - middle));
    const sigma = Math.max(0.45, 1.4826 * median(deviations));
    const cutoff = Math.max(1.25, middle + 3.25 * sigma);

    robustWeights = Float64Array.from(residuals, (value) => {
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
  line.support = residuals.filter(
    (value) => value <= Math.max(1.5, line.residual * 2.5),
  ).length / samples.length;
  line.score = line.support * typicalStrength * alignment / (1 + line.residual);
  return line;
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

  function luminance(ix, iy) {
    const offset = (iy * image.width + ix) * 4;
    return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
  }

  const top = luminance(x0, y0) * (1 - fx) + luminance(x1, y0) * fx;
  const bottom = luminance(x0, y1) * (1 - fx) + luminance(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
}

function refineEdgeFromGradient(image, a, b, shortSide) {
  const length = distance(a, b);
  if (length < 40) return null;

  const direction = {
    x: (b.x - a.x) / length,
    y: (b.y - a.y) / length,
  };
  const normal = { x: -direction.y, y: direction.x };
  const band = clamp(shortSide * 0.03, 7, 42);
  const sampleCount = clamp(Math.round(length / 5), 80, 650);
  const positive = [];
  const negative = [];
  const minOffset = -Math.floor(band);
  const maxOffset = Math.floor(band);

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const t = 0.06 + (sampleIndex / Math.max(1, sampleCount - 1)) * 0.88;
    const baseX = a.x + (b.x - a.x) * t;
    const baseY = a.y + (b.y - a.y) * t;
    const profile = [];

    for (let offset = minOffset; offset <= maxOffset; offset += 1) {
      const minus = sampleGray(
        image,
        baseX + normal.x * (offset - 1),
        baseY + normal.y * (offset - 1),
      );
      const plus = sampleGray(
        image,
        baseX + normal.x * (offset + 1),
        baseY + normal.y * (offset + 1),
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
      const edgeOffset = minOffset + bestIndex + delta;
      const point = {
        x: baseX + normal.x * edgeOffset,
        y: baseY + normal.y * edgeOffset,
        strength: bestStrength,
      };
      (polarity > 0 ? positive : negative).push(point);
    }
  }

  const lines = [
    fitWeightedGeometricLine(positive, direction),
    fitWeightedGeometricLine(negative, direction),
  ].filter(Boolean);
  if (!lines.length) return null;

  lines.sort((first, second) => second.score - first.score);
  const best = lines[0];
  if (best.support < 0.45 || best.residual > Math.max(2.4, band * 0.22)) return null;
  return best;
}

function lineFromPoints(a, b) {
  const length = Math.max(1e-6, distance(a, b));
  return {
    point: { x: a.x, y: a.y },
    direction: { x: (b.x - a.x) / length, y: (b.y - a.y) / length },
  };
}

function lineIntersection(first, second) {
  const denominator = first.direction.x * second.direction.y
    - first.direction.y * second.direction.x;
  if (Math.abs(denominator) < 1e-6) return null;

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

function refineQuadSubpixel(image, roughPoints) {
  const rough = orderQuad(roughPoints);
  const metrics = quadMetrics(rough);
  const lines = [];
  let refinedEdges = 0;

  for (let i = 0; i < 4; i += 1) {
    const a = rough[i];
    const b = rough[(i + 1) % 4];
    const refined = refineEdgeFromGradient(image, a, b, metrics.shortSide);
    if (refined) refinedEdges += 1;
    lines.push(refined || lineFromPoints(a, b));
  }

  if (refinedEdges < 2) {
    return { points: rough, refinedEdges: 0, subpixelRefined: false };
  }

  const points = [
    lineIntersection(lines[3], lines[0]),
    lineIntersection(lines[0], lines[1]),
    lineIntersection(lines[1], lines[2]),
    lineIntersection(lines[2], lines[3]),
  ];
  if (points.some((point) => !point)) {
    return { points: rough, refinedEdges: 0, subpixelRefined: false };
  }

  const maxMove = Math.max(14, metrics.shortSide * 0.08);
  if (points.some((point, index) => distance(point, rough[index]) > maxMove)) {
    return { points: rough, refinedEdges: 0, subpixelRefined: false };
  }
  if (!isConvexQuad(points)) {
    return { points: rough, refinedEdges: 0, subpixelRefined: false };
  }

  const refinedMetrics = quadMetrics(points);
  const areaRatio = refinedMetrics.area / Math.max(1, metrics.area);
  if (areaRatio < 0.78 || areaRatio > 1.22 || refinedMetrics.ratio < 2.6 || refinedMetrics.ratio > 7.7) {
    return { points: rough, refinedEdges: 0, subpixelRefined: false };
  }

  return {
    points: orderQuad(points),
    refinedEdges,
    subpixelRefined: true,
  };
}

function cropBounds(points, width, height) {
  const metrics = quadMetrics(points);
  const margin = Math.max(10, Math.round(metrics.shortSide * 0.08));
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);

  const left = clamp(Math.floor(Math.min(...xs) - margin), 0, width - 1);
  const top = clamp(Math.floor(Math.min(...ys) - margin), 0, height - 1);
  const right = clamp(Math.ceil(Math.max(...xs) + margin), left + 1, width);
  const bottom = clamp(Math.ceil(Math.max(...ys) + margin), top + 1, height);
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function squareToQuad(points) {
  const [p0, p1, p2, p3] = points;
  const dx1 = p1.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dx2 = p3.x - p2.x;
  const dy2 = p3.y - p2.y;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const denominator = dx1 * dy2 - dx2 * dy1;

  if (Math.abs(denominator) < 1e-8) {
    return {
      a: p1.x - p0.x,
      b: p3.x - p0.x,
      c: p0.x,
      d: p1.y - p0.y,
      e: p3.y - p0.y,
      f: p0.y,
      g: 0,
      h: 0,
    };
  }

  const g = (sx * dy2 - dx2 * sy) / denominator;
  const h = (dx1 * sy - sx * dy1) / denominator;
  return {
    a: p1.x - p0.x + g * p1.x,
    b: p3.x - p0.x + h * p3.x,
    c: p0.x,
    d: p1.y - p0.y + g * p1.y,
    e: p3.y - p0.y + h * p3.y,
    f: p0.y,
    g,
    h,
  };
}

function warpImageData(source, localQuad) {
  const ordered = orderQuad(localQuad);
  const [tl, tr, br, bl] = ordered;
  const measuredWidth = Math.max(distance(tl, tr), distance(bl, br));
  const measuredHeight = Math.max(distance(tl, bl), distance(tr, br));
  const shortSide = Math.min(measuredWidth, measuredHeight);
  const longSide = Math.max(measuredWidth, measuredHeight);
  const outputScale = Math.min(1, 1400 / shortSide, 6500 / longSide);

  let outputWidth;
  let outputHeight;
  let mappingPoints;

  if (measuredWidth <= measuredHeight) {
    outputWidth = Math.max(2, Math.round(measuredWidth * outputScale));
    outputHeight = Math.max(2, Math.round(measuredHeight * outputScale));
    mappingPoints = [tl, tr, br, bl];
  } else {
    outputWidth = Math.max(2, Math.round(measuredHeight * outputScale));
    outputHeight = Math.max(2, Math.round(measuredWidth * outputScale));
    // Equivalent to rotating the normal horizontal warp 90 degrees clockwise.
    mappingPoints = [bl, tl, tr, br];
  }

  const transform = squareToQuad(mappingPoints);
  const destination = new ImageData(outputWidth, outputHeight);
  const input = source.data;
  const output = destination.data;
  const sourceWidth = source.width;
  const sourceHeight = source.height;
  const xDenominator = Math.max(1, outputWidth - 1);
  const yDenominator = Math.max(1, outputHeight - 1);

  for (let y = 0; y < outputHeight; y += 1) {
    const v = y / yDenominator;
    let numeratorX = transform.b * v + transform.c;
    let numeratorY = transform.e * v + transform.f;
    let denominator = transform.h * v + 1;

    const stepX = transform.a / xDenominator;
    const stepY = transform.d / xDenominator;
    const stepDenominator = transform.g / xDenominator;

    let outputOffset = y * outputWidth * 4;
    for (let x = 0; x < outputWidth; x += 1) {
      const inverse = Math.abs(denominator) > 1e-8 ? 1 / denominator : 1;
      const sourceX = clamp(numeratorX * inverse, 0, sourceWidth - 1);
      const sourceY = clamp(numeratorY * inverse, 0, sourceHeight - 1);

      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      const x1 = Math.min(sourceWidth - 1, x0 + 1);
      const y1 = Math.min(sourceHeight - 1, y0 + 1);
      const fx = sourceX - x0;
      const fy = sourceY - y0;

      const o00 = (y0 * sourceWidth + x0) * 4;
      const o10 = (y0 * sourceWidth + x1) * 4;
      const o01 = (y1 * sourceWidth + x0) * 4;
      const o11 = (y1 * sourceWidth + x1) * 4;
      const topWeight = 1 - fy;
      const leftWeight = 1 - fx;

      for (let channel = 0; channel < 3; channel += 1) {
        const top = input[o00 + channel] * leftWeight + input[o10 + channel] * fx;
        const bottom = input[o01 + channel] * leftWeight + input[o11 + channel] * fx;
        output[outputOffset + channel] = Math.round(top * topWeight + bottom * fy);
      }
      output[outputOffset + 3] = 255;

      outputOffset += 4;
      numeratorX += stepX;
      numeratorY += stepY;
      denominator += stepDenominator;
    }
  }

  return destination;
}

async function refineAndWarpReceipt(originalBitmap, roughQuad, index) {
  const bounds = cropBounds(roughQuad.points, originalBitmap.width, originalBitmap.height);
  const cropStarted = performance.now();

  const cropCanvas = new OffscreenCanvas(bounds.width, bounds.height);
  const cropContext = cropCanvas.getContext('2d', {
    alpha: false,
    willReadFrequently: true,
  });
  if (!cropContext) throw new Error('Could not create receipt crop canvas.');

  cropContext.fillStyle = '#fff';
  cropContext.fillRect(0, 0, bounds.width, bounds.height);
  cropContext.drawImage(
    originalBitmap,
    bounds.left,
    bounds.top,
    bounds.width,
    bounds.height,
    0,
    0,
    bounds.width,
    bounds.height,
  );
  const image = cropContext.getImageData(0, 0, bounds.width, bounds.height);
  const localRough = roughQuad.points.map((point) => ({
    x: point.x - bounds.left,
    y: point.y - bounds.top,
  }));

  const refinement = refineQuadSubpixel(image, localRough);
  const refinedGlobal = refinement.points.map((point) => ({
    x: point.x + bounds.left,
    y: point.y + bounds.top,
  }));

  postLog('worker-receipt-refined', {
    index,
    refinedEdges: refinement.refinedEdges,
    subpixelRefined: refinement.subpixelRefined,
    elapsedMs: Math.round(performance.now() - cropStarted),
  });

  const warpStarted = performance.now();
  const warped = warpImageData(image, refinement.points);

  postLog('worker-receipt-warped', {
    index,
    width: warped.width,
    height: warped.height,
    elapsedMs: Math.round(performance.now() - warpStarted),
  });

  const metrics = quadMetrics(refinedGlobal);
  const center = refinedGlobal.reduce(
    (acc, point) => ({ x: acc.x + point.x / 4, y: acc.y + point.y / 4 }),
    { x: 0, y: 0 },
  );

  return {
    quad: {
      ...roughQuad,
      points: orderQuad(refinedGlobal),
      center,
      ...metrics,
      refinedEdges: refinement.refinedEdges,
      subpixelRefined: refinement.subpixelRefined,
    },
    pixels: {
      width: warped.width,
      height: warped.height,
      buffer: warped.data.buffer,
    },
  };
}

async function scanImage(bitmap) {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new Error('This Safari version does not expose OffscreenCanvas inside workers.');
  }
  const started = performance.now();
  const maximumDetectionDimension = 2000;
  const scale = Math.min(
    1,
    maximumDetectionDimension / Math.max(bitmap.width, bitmap.height),
  );
  const detectionWidth = Math.max(1, Math.round(bitmap.width * scale));
  const detectionHeight = Math.max(1, Math.round(bitmap.height * scale));

  const detectionCanvas = new OffscreenCanvas(detectionWidth, detectionHeight);
  const detectionContext = detectionCanvas.getContext('2d', {
    alpha: false,
    willReadFrequently: true,
  });
  if (!detectionContext) throw new Error('Could not create detection canvas.');

  detectionContext.drawImage(bitmap, 0, 0, detectionWidth, detectionHeight);
  const detectionImage = detectionContext.getImageData(
    0,
    0,
    detectionWidth,
    detectionHeight,
  );

  postLog('worker-detection-image-ready', {
    sourceWidth: bitmap.width,
    sourceHeight: bitmap.height,
    detectionWidth,
    detectionHeight,
    scale,
  });

  const roughDetectionQuads = detectPaperQuads(detectionImage);
  if (!roughDetectionQuads.length) {
    bitmap.close?.();
    return { quads: [], pixels: [] };
  }

  const roughSourceQuads = roughDetectionQuads.map((quad) => ({
    ...quad,
    points: quad.points.map((point) => ({
      x: point.x / scale,
      y: point.y / scale,
    })),
    center: {
      x: quad.center.x / scale,
      y: quad.center.y / scale,
    },
    width: quad.width / scale,
    height: quad.height / scale,
    shortSide: quad.shortSide / scale,
    longSide: quad.longSide / scale,
    area: quad.area / (scale * scale),
  }));

  const results = [];
  for (let index = 0; index < roughSourceQuads.length; index += 1) {
    results.push(await refineAndWarpReceipt(bitmap, roughSourceQuads[index], index));
  }
  bitmap.close?.();

  results.sort((a, b) => a.quad.center.x - b.quad.center.x || a.quad.center.y - b.quad.center.y);

  postLog('worker-scan-complete', {
    receiptCount: results.length,
    elapsedMs: Math.round(performance.now() - started),
  });

  return {
    quads: results.map((result) => result.quad),
    pixels: results.map((result) => result.pixels),
  };
}

self.onmessage = async (event) => {
  const message = event.data || {};

  try {
    if (message.type === 'init') {
      postLog('worker-built-in-detector-init', {
        offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
        imageData: typeof ImageData !== 'undefined',
      });
      postMessage({ type: 'ready', engine: 'built-in-js' });
      return;
    }

    if (message.type === 'scan') {
      const result = await scanImage(message.bitmap);
      const transfers = result.pixels.map((item) => item.buffer);
      postMessage({
        type: 'scan-result',
        requestId: message.requestId,
        quads: result.quads,
        receipts: result.pixels,
        engine: 'built-in-js',
      }, transfers);
    }
  } catch (error) {
    postError(error, {
      type: message.type,
      requestId: message.requestId || null,
    });
  }
};
