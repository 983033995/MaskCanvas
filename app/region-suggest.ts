import type { Point, Shape } from '../packages/shared/types';
import { buildEdgeMap, type EdgeMap } from './magnetic-lasso';
import { maskToPolygon, createMask, countMaskPixels, type MaskBuffer } from './mask-morphology';

export interface SuggestOptions {
  /** Edge strength (0–1) treated as a hard wall. Default 0.22. */
  edgeBarrier?: number;
  /** Max colour ΔE-ish (0–255 RGB L1/3) to stay in seed region. Default 42. */
  colourTolerance?: number;
  /** Hard cap on filled pixels (safety). Default 35% of image. */
  maxFraction?: number;
  /** Seed dilate in source px so a click near an edge still seeds inside. Default 2. */
  seedRadius?: number;
}

export interface SuggestResult {
  shape: Shape;
  pixels: number;
  boundedByEdge: boolean;
  boundedByColour: boolean;
  boundedBySize: boolean;
}

function sampleRgb(data: Uint8ClampedArray, width: number, x: number, y: number): [number, number, number] {
  const o = (y * width + x) * 4;
  return [data[o], data[o + 1], data[o + 2]];
}

function colourDistance(a: [number, number, number], b: [number, number, number]): number {
  return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])) / 3;
}

/**
 * Click-to-suggest region: flood-fill from a seed, stopped by strong edges and
 * colour distance. No SAM / ONNX — pure local edge+colour heuristic for
 * “suggest → human refine” annotate UX.
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
  const edgeBarrier = options.edgeBarrier ?? 0.22;
  const colourTolerance = options.colourTolerance ?? 42;
  const maxFraction = options.maxFraction ?? 0.35;
  const seedRadius = Math.max(0, Math.round(options.seedRadius ?? 2));
  const maxPixels = Math.max(16, Math.floor(width * height * maxFraction));

  const map: EdgeMap = buildEdgeMap(rgba, width, height);
  const seedColour = sampleRgb(rgba, width, sx, sy);
  const mask: MaskBuffer = createMask(width, height, 0);
  const queue: number[] = [];
  let boundedByEdge = false;
  let boundedByColour = false;
  let boundedBySize = false;

  const trySeed = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
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

  // Clear seeds that landed on a barrier pixel (except exact click).
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
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
  while (head < queue.length) {
    if (queue.length > maxPixels) { boundedBySize = true; break; }
    const id = queue[head++];
    const x = id % width, y = Math.floor(id / width);
    for (const [dx, dy] of dirs) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const nid = ny * width + nx;
      if (mask[nid]) continue;
      if (map.strength[nid] >= edgeBarrier) { boundedByEdge = true; continue; }
      const dist = colourDistance(seedColour, sampleRgb(rgba, width, nx, ny));
      if (dist > colourTolerance) { boundedByColour = true; continue; }
      mask[nid] = 255;
      queue.push(nid);
    }
  }

  const pixels = countMaskPixels(mask);
  if (pixels < 4) return null;
  const polygon = maskToPolygon(mask, width, height);
  if (!polygon || polygon.length < 3) return null;
  return {
    shape: { type: 'polygon', points: polygon },
    pixels,
    boundedByEdge,
    boundedByColour,
    boundedBySize,
  };
}

/** Downscale helper for large photos before suggest (keeps original-coord output). */
export function suggestRegionFromImageData(
  imageData: ImageData,
  seedOriginal: Point,
  imageWidth: number,
  imageHeight: number,
  options?: SuggestOptions,
): SuggestResult | null {
  const { width, height, data } = imageData;
  const seed = {
    x: seedOriginal.x * width / imageWidth,
    y: seedOriginal.y * height / imageHeight,
  };
  const result = suggestRegionFromClick(data, width, height, seed, options);
  if (!result || result.shape.type !== 'polygon') return result;
  const scaleX = imageWidth / width, scaleY = imageHeight / height;
  return {
    ...result,
    shape: {
      type: 'polygon',
      points: result.shape.points.map(p => ({ x: p.x * scaleX, y: p.y * scaleY })),
    },
  };
}
