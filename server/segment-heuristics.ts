/**
 * Server-side region proposals from image heuristics (no neural net).
 * Used by POST /propose-regions and MCP canvas_propose_regions to draft
 * EditProposal snapshots — never auto-confirms.
 */
import sharp from 'sharp';
import type { Region, Shape } from '../packages/shared/types.js';
import { suggestRegionFromPrompts, type PromptPoint } from '../app/region-suggest.js';
import { buildEdgeMap } from '../app/magnetic-lasso.js';

export interface ProposedRegion {
  region: Region;
  reason: string;
  confidence: number;
  pixels: number;
  seed: { x: number; y: number };
}

export interface ProposeRegionsOptions {
  maxRegions?: number;
  hints?: PromptPoint[];
  colourTolerance?: number;
  edgeBarrier?: number;
}

function rgbaFromRaw(raw: Buffer, width: number, height: number): Uint8ClampedArray {
  // sharp raw may be 3 or 4 channels; normalize to RGBA.
  if (raw.length === width * height * 4) return new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, p = 0; i < width * height; i++, p += 3) {
    const o = i * 4;
    rgba[o] = raw[p]; rgba[o + 1] = raw[p + 1]; rgba[o + 2] = raw[p + 2]; rgba[o + 3] = 255;
  }
  return rgba;
}

/** Pick interior seeds: local colour stability + nearby edge energy. */
export function autoSeeds(rgba: Uint8ClampedArray, width: number, height: number, count: number): PromptPoint[] {
  const map = buildEdgeMap(rgba, width, height);
  const grid = Math.max(3, Math.ceil(Math.sqrt(count * 4)));
  const cellW = width / grid, cellH = height / grid;
  const scored: { x: number; y: number; score: number }[] = [];
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const cx = Math.floor((gx + 0.5) * cellW);
      const cy = Math.floor((gy + 0.5) * cellH);
      if (cx < 2 || cy < 2 || cx >= width - 2 || cy >= height - 2) continue;
      // Skip cells that are almost edge or almost flat empty border.
      let edgeSum = 0, colourVar = 0;
      const samples: number[] = [];
      for (let dy = -4; dy <= 4; dy += 2) for (let dx = -4; dx <= 4; dx += 2) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        edgeSum += map.strength[y * width + x];
        const o = (y * width + x) * 4;
        samples.push(rgba[o] * 0.3 + rgba[o + 1] * 0.4 + rgba[o + 2] * 0.3);
      }
      if (!samples.length) continue;
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      colourVar = samples.reduce((a, b) => a + Math.abs(b - mean), 0) / samples.length;
      const centerEdge = map.strength[cy * width + cx];
      // Prefer moderate interior contrast, not on strong edges, not flat sky.
      const score = colourVar * 1.4 + edgeSum * 0.15 - centerEdge * 8;
      if (colourVar < 2 && edgeSum < 0.4) continue;
      scored.push({ x: cx, y: cy, score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const picked: PromptPoint[] = [];
  const minDist = Math.min(width, height) * 0.12;
  for (const s of scored) {
    if (picked.some((p) => Math.hypot(p.x - s.x, p.y - s.y) < minDist)) continue;
    picked.push({ x: s.x, y: s.y, label: 1 });
    if (picked.length >= count) break;
  }
  if (!picked.length) {
    picked.push({ x: Math.floor(width / 2), y: Math.floor(height / 2), label: 1 });
  }
  return picked;
}

export async function proposeRegionsFromImageBytes(
  bytes: Buffer,
  options: ProposeRegionsOptions = {},
): Promise<{ width: number; height: number; proposals: ProposedRegion[]; engine: 'heuristic' }> {
  const maxRegions = Math.max(1, Math.min(8, options.maxRegions ?? 3));
  const image = sharp(bytes, { failOn: 'none' }).rotate();
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 8 || height < 8) return { width, height, proposals: [], engine: 'heuristic' };

  // Work on a bounded preview for speed; map polygons back to original coords.
  const maxSide = 960;
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const tw = Math.max(8, Math.round(width * scale));
  const th = Math.max(8, Math.round(height * scale));
  const raw = await image.resize(tw, th, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = rgbaFromRaw(raw.data, raw.info.width, raw.info.height);

  // Agent/user hints are in original image pixels; auto seeds are preview-space.
  const promptSpace: PromptPoint[] = options.hints?.length
    ? options.hints.map((h) => ({ x: h.x * scale, y: h.y * scale, label: h.label }))
    : autoSeeds(rgba, tw, th, maxRegions * 2);

  const outX = width / tw, outY = height / th;
  const proposals: ProposedRegion[] = [];
  const occupied = new Uint8Array(tw * th);

  const positives = promptSpace.filter((p) => p.label === 1);
  const negatives = promptSpace.filter((p) => p.label === 0);

  for (const seed of positives) {
    if (proposals.length >= maxRegions) break;
    const sx = Math.max(0, Math.min(tw - 1, Math.round(seed.x)));
    const sy = Math.max(0, Math.min(th - 1, Math.round(seed.y)));
    if (occupied[sy * tw + sx]) continue;

    const result = suggestRegionFromPrompts(
      rgba, tw, th,
      [{ x: sx, y: sy, label: 1 }, ...negatives],
      {
        edgeBarrier: options.edgeBarrier ?? 0.22,
        colourTolerance: options.colourTolerance ?? 40,
        maxFraction: 0.28,
        closeRadius: 1,
        negativeRadius: 8,
      },
    );
    if (!result || result.shape.type !== 'polygon') continue;
    if (result.pixels < Math.max(64, tw * th * 0.002)) continue;

    // Reject heavy overlap with earlier proposals.
    let overlap = 0, total = 0;
    // Rasterize quickly via bounding fill check on polygon bbox samples.
    const pts = result.shape.points;
    let minX = tw, minY = th, maxX = 0, maxY = 0;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const step = Math.max(1, Math.floor(Math.sqrt(result.pixels) / 40));
    for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(th - 1, Math.ceil(maxY)); y += step) {
      for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(tw - 1, Math.ceil(maxX)); x += step) {
        // Point-in-polygon ray cast
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
          if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 0.0) + xi)) inside = !inside;
        }
        if (!inside) continue;
        total++;
        if (occupied[y * tw + x]) overlap++;
        occupied[y * tw + x] = 1;
      }
    }
    if (total > 0 && overlap / total > 0.45) continue;

    const shape: Shape = {
      type: 'polygon',
      points: pts.map((p) => ({ x: p.x * outX, y: p.y * outY })),
    };
    const idx = proposals.length + 1;
    const confidence = Math.max(0.35, Math.min(0.92, 0.55 + (result.boundedByEdge ? 0.15 : 0) + (result.boundedByColour ? 0.1 : 0) - (result.boundedBySize ? 0.15 : 0)));
    proposals.push({
      region: {
        id: `agent-seg-${idx}`,
        name: `建议区域 ${idx}`,
        kind: 'edit',
        intent: 'Agent 启发式选区（待人工确认）',
        feather: 2,
        shapes: [shape],
      },
      reason: `边缘+色彩洪水填充 · 种子 (${Math.round(seed.x * outX)}, ${Math.round(seed.y * outY)}) · ${result.pixels.toLocaleString()} px（预览尺度）`,
      confidence,
      pixels: Math.round(result.pixels * outX * outY),
      seed: { x: Math.round(seed.x * outX), y: Math.round(seed.y * outY) },
    });
  }

  return { width, height, proposals, engine: 'heuristic' };
}
