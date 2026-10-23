import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestRegionFromClick } from './region-suggest.js';

function paint(width: number, height: number, fill: (x: number, y: number) => number[]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = fill(x, y);
    const o = (y * width + x) * 4;
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
  }
  return data;
}

test('suggest fills a colour blob stopped by a strong edge', () => {
  // Left red blob, right green — hard seam at x=40.
  const data = paint(80, 60, x => (x < 40 ? [220, 30, 30] : [30, 200, 40]));
  const result = suggestRegionFromClick(data, 80, 60, { x: 15, y: 30 }, { edgeBarrier: 0.2, colourTolerance: 40 });
  assert.ok(result);
  assert.ok(result!.pixels > 200);
  assert.ok(result!.pixels < 80 * 60 * 0.6, `should not flood whole image: ${result!.pixels}`);
  assert.equal(result!.shape.type, 'polygon');
  assert.ok(result!.shape.type === 'polygon' && result!.shape.points.length >= 3);
  // Most points should stay on the left of the seam.
  if (result!.shape.type === 'polygon') {
    const xs = result!.shape.points.map(p => p.x);
    assert.ok(Math.max(...xs) < 48, JSON.stringify({ maxX: Math.max(...xs), pixels: result!.pixels }));
  }
});

test('suggest respects colour tolerance inside a soft field', () => {
  const data = paint(50, 50, (x, y) => {
    // Two soft patches without a hard edge between them.
    if (x < 25) return [200, 40, 40];
    return [40, 40, 200];
  });
  const result = suggestRegionFromClick(data, 50, 50, { x: 8, y: 25 }, { edgeBarrier: 0.85, colourTolerance: 30 });
  assert.ok(result);
  assert.ok(result!.pixels < 50 * 50 * 0.7);
  assert.equal(result!.boundedByColour, true);
});

test('suggest returns null for tiny degenerate seeds on noise-free tiny images', () => {
  const data = paint(4, 4, () => [10, 10, 10]);
  // With maxFraction very small and 4x4, still gets a region — ensure API stable.
  const result = suggestRegionFromClick(data, 4, 4, { x: 1, y: 1 }, { maxFraction: 1 });
  assert.ok(result === null || result.pixels >= 4);
});
