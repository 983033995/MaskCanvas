import type { Point, Shape } from '../packages/shared/types';
import { buildEdgeMap, type EdgeMap } from './magnetic-lasso';
import { maskToPolygon, createMask, countMaskPixels, dilateMask, erodeMask, type MaskBuffer } from './mask-morphology';

export interface SuggestOptions {
  /** Edge strength (0–1) treated as a hard wall. Default 0.2. */
  edgeBarrier?: number;
  /** Max colour Δ (0–255 RGB L1/3) to stay in seed region. Default 38. */
  colourTolerance?: number;
  /** Hard cap on filled pixels. Default 35% of image. */
  maxFraction?: number;
  /** Seed dilate in source px. Default 2. */
  seedRadius?: number;
  /** Optional axis-aligned constraint in image pixel space. */
  clipBox?: { x: number; y: number; width: number; height: number };
  /** Soft closing iterations after fill (dilate then erode). Default 1. */
  closeRadius?: number;
  /** Extra positive click seeds (SAM-like include). */
  positives?: Point[];
  /** Negative clicks carve / block expansion (SAM-like exclude). */
  negatives?: Point[];
  /** Negative exclusion radius in pixels. Default 8. */
  negativeRadius?: number;
}

export interface SuggestResult {
  shape: Shape;
  pixels: number;
  boundedByEdge: boolean;
  boundedByColour: boolean;
  boundedBySize: boolean;
  boundedByBox: boolean;
}

function sampleRgb(data: Uint8ClampedArray, width: number, x: number, y: number): [number, number, number] {
  const o = (y * width + x) * 4;
  return [data[o], data[o + 1], data[o + 2]];
}

function colourDistance(a: [number, number, number], b: [number, number, number]): number {
  // Slightly weight green (human luminance bias) without full Lab.
  return (0.3 * Math.abs(a[0] - b[0]) + 0.4 * Math.abs(a[1] - b[1]) + 0.3 * Math.abs(a[2] - b[2]));
}

function inBox(x: number, y: number, box?: SuggestOptions['clipBox']): boolean {
  if (!box) return true;
  return x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;
}

function medianColour(data: Uint8ClampedArray, width: number, height: number, box: { x: number; y: number; width: number; height: number }): [number, number, number] {
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const x0 = Math.max(0, Math.floor(box.x)), y0 = Math.max(0, Math.floor(box.y));
  const x1 = Math.min(width, Math.ceil(box.x + box.width)), y1 = Math.min(height, Math.ceil(box.y + box.height));
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 400)));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const [r, g, b] = sampleRgb(data, width, x, y);
    rs.push(r); gs.push(g); bs.push(b);
  }
  const mid = (arr: number[]) => { arr.sort((a, b) => a - b); return arr[Math.floor(arr.length / 2)] ?? 0; };
  return [mid(rs), mid(gs), mid(bs)];
}

/**
 * Click-to-suggest region: flood-fill from a seed, stopped by strong edges and
 * colour distance. Optional clip box for drag-rect suggest. Soft-close cleans holes.
 */
export function suggestRegionFromClick(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  seed: Point,
  options: SuggestOptions = {},
): SuggestResult | null {
  if (width < 2 || height < 2 || rgba.length < width * height * 4) return null;
  const sx = Math.max(0, Math.min(width - 1, Math.round(seed.x)));
  const sy = Math.max(0, Math.min(height - 1, Math.round(seed.y)));
  if (!inBox(sx, sy, options.clipBox)) return null;

  const edgeBarrier = options.edgeBarrier ?? 0.2;
  const colourTolerance = options.colourTolerance ?? 38;
  const maxFraction = options.maxFraction ?? 0.35;
  const seedRadius = Math.max(0, Math.round(options.seedRadius ?? 2));
  const closeRadius = Math.max(0, Math.round(options.closeRadius ?? 1));
  const maxPixels = Math.max(16, Math.floor(width * height * maxFraction));

  const map: EdgeMap = buildEdgeMap(rgba, width, height);
  const seedColour = options.clipBox
    ? medianColour(rgba, width, height, options.clipBox)
    : sampleRgb(rgba, width, sx, sy);
  const mask: MaskBuffer = createMask(width, height, 0);
  const queue: number[] = [];
  let boundedByEdge = false;
  let boundedByColour = false;
  let boundedBySize = false;
  let boundedByBox = false;

  const trySeed = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    if (!inBox(x, y, options.clipBox)) return;
    const id = y * width + x;
    if (mask[id]) return;
    mask[id] = 255;
    queue.push(id);
  };
  for (let dy = -seedRadius; dy <= seedRadius; dy++) for (let dx = -seedRadius; dx <= seedRadius; dx++) {
    if (dx * dx + dy * dy <= seedRadius * seedRadius) trySeed(sx + dx, sy + dy);
  }
  if (!queue.length) trySeed(sx, sy);
  if (!queue.length) return null;

  for (let i = queue.length - 1; i >= 0; i--) {
    const id = queue[i];
    if (map.strength[id] >= edgeBarrier && id !== sy * width + sx) {
      mask[id] = 0;
      queue.splice(i, 1);
    }
  }
  if (!queue.length) {
    mask[sy * width + sx] = 255;
    queue.push(sy * width + sx);
  }

  let head = 0;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
  while (head < queue.length) {
    if (queue.length > maxPixels) { boundedBySize = true; break; }
    const id = queue[head++];
    const x = id % width, y = Math.floor(id / width);
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!inBox(nx, ny, options.clipBox)) { boundedByBox = true; continue; }
      const nid = ny * width + nx;
      if (mask[nid]) continue;
      // Diagonal steps require a slightly stronger barrier so weak corners don't leak.
      const barrier = (dx && dy) ? edgeBarrier * 0.92 : edgeBarrier;
      if (map.strength[nid] >= barrier) { boundedByEdge = true; continue; }
      const dist = colourDistance(seedColour, sampleRgb(rgba, width, nx, ny));
      if (dist > colourTolerance) { boundedByColour = true; continue; }
      mask[nid] = 255;
      queue.push(nid);
    }
  }

  let cleaned = mask;
  if (closeRadius > 0) {
    cleaned = erodeMask(dilateMask(mask, width, height, closeRadius), width, height, closeRadius);
    // Keep seed membership.
    cleaned[sy * width + sx] = 255;
  }

  const pixels = countMaskPixels(cleaned);
  if (pixels < 4) return null;
  const polygon = maskToPolygon(cleaned, width, height);
  if (!polygon || polygon.length < 3) return null;
  return {
    shape: { type: 'polygon', points: polygon },
    pixels,
    boundedByEdge,
    boundedByColour,
    boundedBySize,
    boundedByBox,
  };
}

/** Drag-box suggest: fill inside the box from its centre using box median colour. */
export function suggestRegionFromBox(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  box: { x: number; y: number; width: number; height: number },
  options: SuggestOptions = {},
): SuggestResult | null {
  const x = Math.max(0, Math.floor(Math.min(box.x, box.x + box.width)));
  const y = Math.max(0, Math.floor(Math.min(box.y, box.y + box.height)));
  const w = Math.min(width - x, Math.ceil(Math.abs(box.width)));
  const h = Math.min(height - y, Math.ceil(Math.abs(box.height)));
  if (w < 4 || h < 4) return null;
  const clip = { x, y, width: w, height: h };
  const seed = { x: x + w / 2, y: y + h / 2 };
  return suggestRegionFromClick(rgba, width, height, seed, {
    ...options,
    clipBox: clip,
    maxFraction: options.maxFraction ?? 1,
    colourTolerance: options.colourTolerance ?? 52,
    edgeBarrier: options.edgeBarrier ?? 0.24,
    closeRadius: options.closeRadius ?? 1,
  });
}

export function suggestRegionFromImageData(
  imageData: ImageData,
  seedOriginal: Point,
  imageWidth: number,
  imageHeight: number,
  options?: SuggestOptions,
): SuggestResult | null {
  const { width, height, data } = imageData;
  const scaleX = width / imageWidth, scaleY = height / imageHeight;
  const seed = { x: seedOriginal.x * scaleX, y: seedOriginal.y * scaleY };
  const mapped: SuggestOptions = { ...options };
  if (options?.clipBox) {
    mapped.clipBox = {
      x: options.clipBox.x * scaleX,
      y: options.clipBox.y * scaleY,
      width: options.clipBox.width * scaleX,
      height: options.clipBox.height * scaleY,
    };
  }
  const result = suggestRegionFromClick(data, width, height, seed, mapped);
  if (!result || result.shape.type !== 'polygon') return result;
  const outX = imageWidth / width, outY = imageHeight / height;
  return {
    ...result,
    shape: {
      type: 'polygon',
      points: result.shape.points.map(p => ({ x: p.x * outX, y: p.y * outY })),
    },
  };
}

export function suggestBoxFromImageData(
  imageData: ImageData,
  boxOriginal: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
  options?: SuggestOptions,
): SuggestResult | null {
  const { width, height, data } = imageData;
  const scaleX = width / imageWidth, scaleY = height / imageHeight;
  const box = {
    x: boxOriginal.x * scaleX,
    y: boxOriginal.y * scaleY,
    width: boxOriginal.width * scaleX,
    height: boxOriginal.height * scaleY,
  };
  const result = suggestRegionFromBox(data, width, height, box, options);
  if (!result || result.shape.type !== 'polygon') return result;
  const outX = imageWidth / width, outY = imageHeight / height;
  return {
    ...result,
    shape: {
      type: 'polygon',
      points: result.shape.points.map(p => ({ x: p.x * outX, y: p.y * outY })),
    },
  };
}


export interface PromptPoint extends Point { label: 1 | 0 } // 1 = positive, 0 = negative

/**
 * Multi-prompt suggest (SAM-like UX without SAM weights):
 * union floods from all positive seeds, then carve negative discs + block walls.
 */
export function suggestRegionFromPrompts(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  prompts: PromptPoint[],
  options: SuggestOptions = {},
): SuggestResult | null {
  const positives = prompts.filter(p => p.label === 1);
  const negatives = prompts.filter(p => p.label === 0);
  if (!positives.length) return null;

  const edgeBarrier = options.edgeBarrier ?? 0.2;
  const colourTolerance = options.colourTolerance ?? 42;
  const maxFraction = options.maxFraction ?? 0.4;
  const seedRadius = Math.max(0, Math.round(options.seedRadius ?? 2));
  const closeRadius = Math.max(0, Math.round(options.closeRadius ?? 1));
  const negativeRadius = Math.max(1, Math.round(options.negativeRadius ?? 8));
  // Cap each positive flood, then union — avoids one average colour washing out multi-object prompts.
  const maxPixelsPerSeed = Math.max(16, Math.floor(width * height * Math.min(maxFraction, 0.35)));
  const maxPixelsTotal = Math.max(16, Math.floor(width * height * maxFraction));
  const map = buildEdgeMap(rgba, width, height);

  const blocked = createMask(width, height, 0);
  for (const n of negatives) {
    const nx = Math.round(n.x), ny = Math.round(n.y);
    const r2 = negativeRadius * negativeRadius;
    for (let y = Math.max(0, ny - negativeRadius); y <= Math.min(height - 1, ny + negativeRadius); y++) {
      for (let x = Math.max(0, nx - negativeRadius); x <= Math.min(width - 1, nx + negativeRadius); x++) {
        if ((x - nx) * (x - nx) + (y - ny) * (y - ny) <= r2) blocked[y * width + x] = 255;
      }
    }
  }

  const mask = createMask(width, height, 0);
  let boundedByEdge = false, boundedByColour = false, boundedBySize = false;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

  for (const p of positives) {
    const sx = Math.max(0, Math.min(width - 1, Math.round(p.x)));
    const sy = Math.max(0, Math.min(height - 1, Math.round(p.y)));
    if (blocked[sy * width + sx]) continue;
    // Local colour from a small disc around this positive — not a global average.
    const local: [number, number, number][] = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = sx + dx, y = sy + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      local.push(sampleRgb(rgba, width, x, y));
    }
    const seedColour: [number, number, number] = local.length
      ? [
          Math.round(local.reduce((s, c) => s + c[0], 0) / local.length),
          Math.round(local.reduce((s, c) => s + c[1], 0) / local.length),
          Math.round(local.reduce((s, c) => s + c[2], 0) / local.length),
        ]
      : sampleRgb(rgba, width, sx, sy);

    const queue: number[] = [];
    const trySeed = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return;
      if (!inBox(x, y, options.clipBox)) return;
      const id = y * width + x;
      if (mask[id] || blocked[id]) return;
      mask[id] = 255;
      queue.push(id);
    };
    for (let dy = -seedRadius; dy <= seedRadius; dy++) for (let dx = -seedRadius; dx <= seedRadius; dx++) {
      if (dx * dx + dy * dy <= seedRadius * seedRadius) trySeed(sx + dx, sy + dy);
    }
    trySeed(sx, sy);

    let head = 0;
    let filled = 0;
    let totalFilled = countMaskPixels(mask) - queue.length; // pixels already committed before this seed's queue
    while (head < queue.length) {
      if (filled > maxPixelsPerSeed || totalFilled + queue.length > maxPixelsTotal) { boundedBySize = true; break; }
      const id = queue[head++];
      filled++;
      const x = id % width, y = Math.floor(id / width);
      for (const [dx, dy] of dirs) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (!inBox(nx, ny, options.clipBox)) continue;
        const nid = ny * width + nx;
        if (mask[nid] || blocked[nid]) continue;
        const barrier = (dx && dy) ? edgeBarrier * 0.9 : edgeBarrier;
        // Local adaptive barrier: stronger edges near seed require clearer walls.
        const localBarrier = barrier * (1 - Math.min(0.25, map.strength[sy * width + sx] * 0.3));
        if (map.strength[nid] >= localBarrier) { boundedByEdge = true; continue; }
        if (colourDistance(seedColour, sampleRgb(rgba, width, nx, ny)) > colourTolerance) { boundedByColour = true; continue; }
        mask[nid] = 255;
        queue.push(nid);
      }
    }
  }

  let cleaned = mask;
  if (closeRadius > 0) cleaned = erodeMask(dilateMask(mask, width, height, closeRadius), width, height, closeRadius);
  for (let i = 0; i < cleaned.length; i++) if (blocked[i]) cleaned[i] = 0;
  for (const p of positives) {
    const sx = Math.max(0, Math.min(width - 1, Math.round(p.x)));
    const sy = Math.max(0, Math.min(height - 1, Math.round(p.y)));
    if (!blocked[sy * width + sx]) cleaned[sy * width + sx] = 255;
  }

  const pixels = countMaskPixels(cleaned);
  if (pixels < 4) return null;
  const polygon = maskToPolygon(cleaned, width, height);
  if (!polygon || polygon.length < 3) return null;
  return {
    shape: { type: 'polygon', points: polygon },
    pixels,
    boundedByEdge,
    boundedByColour,
    boundedBySize,
    boundedByBox: Boolean(options.clipBox),
  };
}

export function suggestPromptsFromImageData(
  imageData: ImageData,
  promptsOriginal: PromptPoint[],
  imageWidth: number,
  imageHeight: number,
  options?: SuggestOptions,
): SuggestResult | null {
  const { width, height, data } = imageData;
  const scaleX = width / imageWidth, scaleY = height / imageHeight;
  const prompts = promptsOriginal.map(p => ({ x: p.x * scaleX, y: p.y * scaleY, label: p.label }));
  const mapped: SuggestOptions = { ...options };
  if (options?.clipBox) {
    mapped.clipBox = {
      x: options.clipBox.x * scaleX,
      y: options.clipBox.y * scaleY,
      width: options.clipBox.width * scaleX,
      height: options.clipBox.height * scaleY,
    };
  }
  const result = suggestRegionFromPrompts(data, width, height, prompts, mapped);
  if (!result || result.shape.type !== 'polygon') return result;
  const outX = imageWidth / width, outY = imageHeight / height;
  return {
    ...result,
    shape: { type: 'polygon', points: result.shape.points.map(p => ({ x: p.x * outX, y: p.y * outY })) },
  };
}
