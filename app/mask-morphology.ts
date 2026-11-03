import type { Point, Region, Shape } from '../packages/shared/types';

/** Binary mask: 0 = outside, 255 = inside. Original-image pixel grid. */
export type MaskBuffer = Uint8Array;

export function createMask(width: number, height: number, fill = 0): MaskBuffer {
  return new Uint8Array(width * height).fill(fill);
}

function setPixel(mask: MaskBuffer, width: number, height: number, x: number, y: number, value: number) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  mask[y * width + x] = value;
}

function fillCircle(mask: MaskBuffer, width: number, height: number, cx: number, cy: number, radius: number, value: number) {
  const r = Math.max(0, Math.round(radius));
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(cx - r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const x1 = Math.min(width - 1, Math.ceil(cx + r));
  const y1 = Math.min(height - 1, Math.ceil(cy + r));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = x - cx, dy = y - cy;
    if (dx * dx + dy * dy <= r2) mask[y * width + x] = value;
  }
}

function fillPolygon(mask: MaskBuffer, width: number, height: number, points: Point[], value: number) {
  if (points.length < 3) return;
  let minY = height, maxY = -1, minX = width, maxX = -1;
  for (const p of points) {
    minX = Math.min(minX, Math.floor(p.x));
    maxX = Math.max(maxX, Math.ceil(p.x));
    minY = Math.min(minY, Math.floor(p.y));
    maxY = Math.max(maxY, Math.ceil(p.y));
  }
  minX = Math.max(0, minX); maxX = Math.min(width - 1, maxX);
  minY = Math.max(0, minY); maxY = Math.min(height - 1, maxY);
  for (let y = minY; y <= maxY; y++) {
    const crossings: number[] = [];
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i], b = points[j];
      if ((a.y > y) !== (b.y > y)) {
        const x = a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y);
        crossings.push(x);
      }
    }
    crossings.sort((u, v) => u - v);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const left = Math.max(minX, Math.ceil(crossings[i]));
      const right = Math.min(maxX, Math.floor(crossings[i + 1]));
      for (let x = left; x <= right; x++) mask[y * width + x] = value;
    }
  }
}

function paintShape(mask: MaskBuffer, width: number, height: number, shape: Shape) {
  const value = shape.subtract ? 0 : 255;
  if (shape.type === 'rect') {
    const x0 = Math.max(0, Math.floor(Math.min(shape.x, shape.x + shape.width)));
    const y0 = Math.max(0, Math.floor(Math.min(shape.y, shape.y + shape.height)));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(shape.x, shape.x + shape.width)) - 1);
    const y1 = Math.min(height - 1, Math.ceil(Math.max(shape.y, shape.y + shape.height)) - 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) mask[y * width + x] = value;
    return;
  }
  if (shape.type === 'polygon') {
    fillPolygon(mask, width, height, shape.points, value);
    return;
  }
  if (shape.points.length === 1) {
    fillCircle(mask, width, height, shape.points[0].x, shape.points[0].y, shape.radius, value);
    return;
  }
  for (let i = 0; i < shape.points.length; i++) {
    const p = shape.points[i];
    fillCircle(mask, width, height, p.x, p.y, shape.radius, value);
    if (i === 0) continue;
    const a = shape.points[i - 1], b = p;
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      fillCircle(mask, width, height, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, shape.radius, value);
    }
  }
}

/** Rasterize region shapes onto a binary mask (additive then subtractive order preserved). */
export function rasterizeRegionMask(shapes: Shape[], width: number, height: number): MaskBuffer {
  const mask = createMask(width, height, 0);
  for (const shape of shapes) paintShape(mask, width, height, shape);
  return mask;
}

export function countMaskPixels(mask: MaskBuffer): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n++;
  return n;
}

/** Chebyshev dilation by integer radius (square kernel). */
export function dilateMask(mask: MaskBuffer, width: number, height: number, radius: number): MaskBuffer {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return Uint8Array.from(mask);
  const out = createMask(width, height, 0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!mask[y * width + x]) continue;
    const x0 = Math.max(0, x - r), x1 = Math.min(width - 1, x + r);
    const y0 = Math.max(0, y - r), y1 = Math.min(height - 1, y + r);
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) out[yy * width + xx] = 255;
  }
  return out;
}

/** Chebyshev erosion by integer radius. */
export function erodeMask(mask: MaskBuffer, width: number, height: number, radius: number): MaskBuffer {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return Uint8Array.from(mask);
  const out = createMask(width, height, 0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!mask[y * width + x]) continue;
    let keep = true;
    const x0 = Math.max(0, x - r), x1 = Math.min(width - 1, x + r);
    const y0 = Math.max(0, y - r), y1 = Math.min(height - 1, y + r);
    // Boundary of image counts as outside for inward semantics.
    if (x - r < 0 || y - r < 0 || x + r >= width || y + r >= height) { keep = false; }
    else {
      outer: for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        if (!mask[yy * width + xx]) { keep = false; break outer; }
      }
    }
    if (keep) out[y * width + x] = 255;
  }
  return out;
}

export function invertMask(mask: MaskBuffer): MaskBuffer {
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] ? 0 : 255;
  return out;
}

/**
 * Approximate the server inward-feather alpha (distance-to-outside / saturation).
 * Returns 0–255 alpha; outside stays 0. Used only for live canvas preview.
 */
export function inwardFeatherAlpha(mask: MaskBuffer, width: number, height: number, feather: number): Uint8Array {
  if (feather <= 0) {
    const copy = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) copy[i] = mask[i] ? 255 : 0;
    return copy;
  }
  const saturation = (feather + 1) * 10;
  const distance = new Uint16Array(mask.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (mask[index]) distance[index] = x === 0 || y === 0 || x === width - 1 || y === height - 1 ? 10 : saturation;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (!mask[index]) continue;
    let best = distance[index];
    if (x > 0) best = Math.min(best, distance[index - 1] + 10);
    if (y > 0) best = Math.min(best, distance[index - width] + 10);
    if (x > 0 && y > 0) best = Math.min(best, distance[index - width - 1] + 14);
    if (x + 1 < width && y > 0) best = Math.min(best, distance[index - width + 1] + 14);
    distance[index] = best;
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const index = y * width + x;
    if (!mask[index]) continue;
    let best = distance[index];
    if (x + 1 < width) best = Math.min(best, distance[index + 1] + 10);
    if (y + 1 < height) best = Math.min(best, distance[index + width] + 10);
    if (x + 1 < width && y + 1 < height) best = Math.min(best, distance[index + width + 1] + 14);
    if (x > 0 && y + 1 < height) best = Math.min(best, distance[index + width - 1] + 14);
    distance[index] = best;
  }
  const alpha = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) alpha[i] = mask[i] ? Math.min(255, Math.round(255 * distance[i] / saturation)) : 0;
  return alpha;
}

/** Moore-neighborhood outer contour → closed polygon in original pixels. */
export function maskToPolygon(mask: MaskBuffer, width: number, height: number): Point[] | null {
  let start = -1;
  for (let i = 0; i < mask.length; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return null;
  const sx = start % width, sy = Math.floor(start / width);
  // Prefer the leftmost then topmost solid pixel that has an outside neighbor.
  let bx = sx, by = sy;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!mask[y * width + x]) continue;
    const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1
      || !mask[y * width + x - 1] || !mask[y * width + x + 1]
      || !mask[(y - 1) * width + x] || !mask[(y + 1) * width + x];
    if (edge) { bx = x; by = y; y = height; break; }
  }
  const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]] as const;
  const points: Point[] = [];
  let x = bx, y = by, dir = 0;
  const limit = width * height * 8;
  for (let step = 0; step < limit; step++) {
    points.push({ x: x + 0.5, y: y + 0.5 });
    let found = false;
    for (let k = 0; k < 8; k++) {
      const nd = (dir + 6 + k) % 8; // turn left-ish from previous
      const nx = x + dirs[nd][0], ny = y + dirs[nd][1];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!mask[ny * width + nx]) continue;
      x = nx; y = ny; dir = nd; found = true; break;
    }
    if (!found) break;
    if (x === bx && y === by && points.length > 2) break;
  }
  if (points.length < 3) {
    // Degenerate: emit a 1×1 square around the seed.
    return [
      { x: bx, y: by }, { x: bx + 1, y: by },
      { x: bx + 1, y: by + 1 }, { x: bx, y: by + 1 },
    ];
  }
  return simplifyPolygon(points, 0.75);
}

function simplifyPolygon(points: Point[], epsilon: number): Point[] {
  if (points.length <= 3) return points;
  const first = points[0], last = points[points.length - 1];
  let maxDist = 0, index = 0;
  const dx = last.x - first.x, dy = last.y - first.y;
  const len2 = dx * dx + dy * dy;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const t = len2 ? Math.max(0, Math.min(1, ((p.x - first.x) * dx + (p.y - first.y) * dy) / len2)) : 0;
    const dist = Math.hypot(p.x - (first.x + t * dx), p.y - (first.y + t * dy));
    if (dist > maxDist) { maxDist = dist; index = i; }
  }
  if (maxDist > epsilon) {
    const left = simplifyPolygon(points.slice(0, index + 1), epsilon);
    const right = simplifyPolygon(points.slice(index), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

export type MorphOp = 'expand' | 'contract' | 'invert';

export interface MorphResult {
  shapes: Shape[];
  beforePixels: number;
  afterPixels: number;
  empty: boolean;
}

/**
 * Apply expand/contract/invert to a region's shapes.
 * Result replaces shapes with a single polygon (or empty list).
 * Does not change region kind / feather / intent.
 */
export function morphRegionShapes(
  region: Pick<Region, 'shapes'>,
  width: number,
  height: number,
  op: MorphOp,
  radius = 4,
): MorphResult {
  if (!region.shapes.length && op !== 'invert') {
    return { shapes: [], beforePixels: 0, afterPixels: 0, empty: true };
  }
  let mask = rasterizeRegionMask(region.shapes, width, height);
  const beforePixels = countMaskPixels(mask);
  const r = Math.max(1, Math.min(64, Math.round(radius)));
  if (op === 'expand') mask = dilateMask(mask, width, height, r);
  else if (op === 'contract') mask = erodeMask(mask, width, height, r);
  else mask = invertMask(mask);
  const afterPixels = countMaskPixels(mask);
  if (afterPixels === 0) return { shapes: [], beforePixels, afterPixels: 0, empty: true };
  if (afterPixels === width * height) {
    return {
      shapes: [{ type: 'rect', x: 0, y: 0, width, height }],
      beforePixels,
      afterPixels,
      empty: false,
    };
  }
  const polygon = maskToPolygon(mask, width, height);
  if (!polygon) return { shapes: [], beforePixels, afterPixels: 0, empty: true };
  return {
    shapes: [{ type: 'polygon', points: polygon }],
    beforePixels,
    afterPixels,
    empty: false,
  };
}

/** Effective solid core of an edit mask after inward feather (alpha >= 250). */
export function featherCoreMask(mask: MaskBuffer, width: number, height: number, feather: number): MaskBuffer {
  const alpha = inwardFeatherAlpha(mask, width, height, feather);
  const core = createMask(width, height, 0);
  for (let i = 0; i < alpha.length; i++) if (alpha[i] >= 250) core[i] = 255;
  return core;
}
