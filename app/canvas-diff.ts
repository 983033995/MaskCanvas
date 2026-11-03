/** Pixel-diff helpers for S06 wipe / heatmap review. Pure buffers; browser paints separately. */

export interface DiffStats {
  changedPixels: number;
  maxChannelDelta: number;
  /** Max of R/G/B channel abs-delta per changed pixel, length = width*height, 0 if unchanged. */
  deltaMap: Uint8Array;
}

/** Compare two RGBA buffers of equal length (width*height*4). */
export function computeChannelDiff(base: Uint8ClampedArray | Uint8Array, candidate: Uint8ClampedArray | Uint8Array, width: number, height: number): DiffStats {
  const pixels = width * height;
  if (base.length < pixels * 4 || candidate.length < pixels * 4) {
    throw new Error('diff buffers smaller than width×height×4');
  }
  const deltaMap = new Uint8Array(pixels);
  let changedPixels = 0;
  let maxChannelDelta = 0;
  for (let pixel = 0; pixel < pixels; pixel++) {
    const offset = pixel * 4;
    let local = 0;
    for (let channel = 0; channel < 3; channel++) {
      const delta = Math.abs(candidate[offset + channel] - base[offset + channel]);
      if (delta > local) local = delta;
      if (delta > maxChannelDelta) maxChannelDelta = delta;
    }
    if (local) {
      changedPixels++;
      deltaMap[pixel] = local;
    }
  }
  return { changedPixels, maxChannelDelta, deltaMap };
}

/**
 * Paint a heatmap into an RGBA buffer: cool→hot by channel delta.
 * Unchanged pixels stay transparent (alpha 0).
 */
export function paintDiffHeatmap(deltaMap: Uint8Array, maxChannelDelta: number, rgba: Uint8ClampedArray | Uint8Array, opacity = 0.72): void {
  const scale = maxChannelDelta > 0 ? 1 / maxChannelDelta : 0;
  for (let i = 0; i < deltaMap.length; i++) {
    const d = deltaMap[i];
    const o = i * 4;
    if (!d) { rgba[o] = 0; rgba[o + 1] = 0; rgba[o + 2] = 0; rgba[o + 3] = 0; continue; }
    const t = d * scale;
    // teal → amber → crimson
    const r = Math.round(40 + t * 200);
    const g = Math.round(180 - t * 140);
    const b = Math.round(160 - t * 140);
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
    rgba[o + 3] = Math.round(255 * opacity * (0.35 + 0.65 * t));
  }
}

export type ReviewCompareMode = 'side' | 'wipe' | 'diff';
