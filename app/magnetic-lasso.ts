import type { Point } from '../packages/shared/types';

export interface EdgeMap {
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
  strength: Float32Array;
}

export interface SnapOptions {
  /** Extra stickiness weight on distance (0–2). Higher = prefer staying near cursor. Default 1. */
  stickiness?: number;
  /** Edge must beat free-cursor baseline by this margin (0–1). Default 0.08. */
  margin?: number;
}

// RGB gradients also detect boundaries between different colours of similar
// luminance. The map is computed once per image, not on every pointer event.
export function buildEdgeMap(data: Uint8ClampedArray, width: number, height: number, imageWidth = width, imageHeight = height): EdgeMap {
  const strength = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    let squared = 0;
    for (let channel = 0; channel < 3; channel++) {
      const dx = data[(y * width + x + 1) * 4 + channel] - data[(y * width + x - 1) * 4 + channel];
      const dy = data[((y + 1) * width + x) * 4 + channel] - data[((y - 1) * width + x) * 4 + channel];
      squared += dx * dx + dy * dy;
    }
    strength[y * width + x] = Math.min(1, Math.sqrt(squared) / 441.7);
  }
  return { width, height, imageWidth, imageHeight, strength };
}

const inMap = (map: EdgeMap, p: Point) => ({ x: Math.max(0, Math.min(map.width - 1, Math.round(p.x * map.width / map.imageWidth))), y: Math.max(0, Math.min(map.height - 1, Math.round(p.y * map.height / map.imageHeight))) });
const fromMap = (map: EdgeMap, p: Point) => ({ x: p.x * map.imageWidth / map.width, y: p.y * map.imageHeight / map.height });

/**
 * Snap only when a *strong* edge lies near the cursor.
 * Flat / weak areas return the free cursor point unchanged — no sticky pull.
 */
export function snapToEdge(map: EdgeMap, point: Point, radius: number, contrast: number, options: SnapOptions = {}): Point {
  const stickiness = options.stickiness ?? 1;
  const margin = options.margin ?? 0.08;
  const p = inMap(map, point);
  const rx = Math.max(1, Math.min(48, Math.ceil(radius * map.width / map.imageWidth)));
  const ry = Math.max(1, Math.min(48, Math.ceil(radius * map.height / map.imageHeight)));
  // Free cursor wins unless an edge clearly beats it.
  let best = contrast + margin;
  let result: Point | undefined;
  for (let y = Math.max(1, p.y - ry); y <= Math.min(map.height - 2, p.y + ry); y++) {
    for (let x = Math.max(1, p.x - rx); x <= Math.min(map.width - 2, p.x + rx); x++) {
      const distance = Math.hypot((x - p.x) / rx, (y - p.y) / ry);
      const edge = map.strength[y * map.width + x];
      if (distance > 1 || edge < contrast) continue;
      // Prefer nearby strong edges; distance is penalised harder than before.
      const score = edge - distance * (0.55 * stickiness);
      if (score > best) { best = score; result = { x, y }; }
    }
  }
  return result ? fromMap(map, result) : point;
}

/** True when snap moved the point onto an edge (not free-follow). */
export function didSnapToEdge(raw: Point, snapped: Point, epsilon = 0.5): boolean {
  return Math.hypot(snapped.x - raw.x, snapped.y - raw.y) > epsilon;
}

class MinHeap {
  items: { id: number; priority: number }[] = [];
  push(value: { id: number; priority: number }) {
    const items = this.items; let i = items.length; items.push(value);
    while (i > 0) { const parent = (i - 1) >> 1; if (items[parent].priority <= value.priority) break; items[i] = items[parent]; i = parent; }
    items[i] = value;
  }
  pop() {
    const items = this.items; const first = items[0], last = items.pop()!;
    if (items.length) {
      let i = 0;
      while (i * 2 + 1 < items.length) {
        let child = i * 2 + 1;
        if (child + 1 < items.length && items[child + 1].priority < items[child].priority) child++;
        if (items[child].priority >= last.priority) break;
        items[i] = items[child]; i = child;
      }
      items[i] = last;
    }
    return first;
  }
}

// Local live-wire: minimum-cost path rewards strong edges, while a corridor
// around the user's movement prevents unrelated distant edges stealing the path.
export function traceEdge(map: EdgeMap, start: Point, end: Point, radius: number, contrast: number): Point[] {
  const a = inMap(map, start), b = inMap(map, end);
  // Tighter corridor than before — less “teleport” to distant edges.
  const margin = Math.max(2, Math.min(28, Math.ceil(radius * map.width / map.imageWidth)));
  const left = Math.max(0, Math.min(a.x, b.x) - margin), top = Math.max(0, Math.min(a.y, b.y) - margin);
  const right = Math.min(map.width - 1, Math.max(a.x, b.x) + margin), bottom = Math.min(map.height - 1, Math.max(a.y, b.y) + margin);
  const w = right - left + 1, h = bottom - top + 1;
  if (w * h > 60_000) return [start, end];
  const distance = new Float32Array(w * h); distance.fill(Infinity);
  const previous = new Int32Array(w * h); previous.fill(-1);
  const visited = new Uint8Array(w * h);
  const source = (a.y - top) * w + a.x - left, target = (b.y - top) * w + b.x - left;
  if (source === target) return [start, end];
  distance[source] = 0;
  const heap = new MinHeap(); heap.push({ id: source, priority: 0 });
  const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
  let count = 0;
  while (heap.items.length && count++ < 60_000) {
    const { id } = heap.pop();
    if (visited[id]) continue;
    visited[id] = 1;
    if (id === target) break;
    const x = id % w + left, y = Math.floor(id / w) + top;
    for (let sy = -1; sy <= 1; sy++) for (let sx = -1; sx <= 1; sx++) {
      if (!sx && !sy) continue;
      const nx = x + sx, ny = y + sy;
      if (nx < left || nx > right || ny < top || ny > bottom) continue;
      const next = (ny - top) * w + nx - left;
      if (visited[next]) continue;
      const strength = map.strength[ny * map.width + nx];
      const edge = strength >= contrast ? strength : 0;
      const deviation = Math.abs(dy * (nx - a.x) - dx * (ny - a.y)) / length;
      // Weaker edges cost more; straight free path stays competitive off-edge.
      const cost = Math.hypot(sx, sy) * (1 + 18 * (1 - edge) ** 2 + 0.12 * deviation);
      const nextDistance = distance[id] + cost;
      if (nextDistance >= distance[next]) continue;
      distance[next] = nextDistance; previous[next] = id;
      heap.push({ id: next, priority: nextDistance + Math.hypot(nx - b.x, ny - b.y) });
    }
  }
  if (source !== target && previous[target] < 0) return [start, end];
  const result: Point[] = [];
  for (let id = target; id >= 0; id = previous[id]) {
    result.push(fromMap(map, { x: id % w + left, y: Math.floor(id / w) + top }));
    if (id === source) break;
  }
  result.reverse();
  result[0] = start; result[result.length - 1] = end;
  return result;
}
