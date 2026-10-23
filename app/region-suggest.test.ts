import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestRegionFromClick, suggestRegionFromBox, suggestRegionFromPrompts } from './region-suggest.js';

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
  const data = paint(80, 60, x => (x < 40 ? [220, 30, 30] : [30, 200, 40]));
  const result = suggestRegionFromClick(data, 80, 60, { x: 15, y: 30 }, { edgeBarrier: 0.2, colourTolerance: 40 });
  assert.ok(result);
  assert.ok(result!.pixels > 200);
  assert.ok(result!.pixels < 80 * 60 * 0.6, `should not flood whole image: ${result!.pixels}`);
  assert.equal(result!.shape.type, 'polygon');
  if (result!.shape.type === 'polygon') {
    const xs = result!.shape.points.map(p => p.x);
    assert.ok(Math.max(...xs) < 50, JSON.stringify({ maxX: Math.max(...xs), pixels: result!.pixels }));
  }
});

test('suggest respects colour tolerance inside a soft field', () => {
  const data = paint(50, 50, (x) => (x < 25 ? [200, 40, 40] : [40, 40, 200]));
  const result = suggestRegionFromClick(data, 50, 50, { x: 8, y: 25 }, { edgeBarrier: 0.85, colourTolerance: 30 });
  assert.ok(result);
  assert.ok(result!.pixels < 50 * 50 * 0.7);
  assert.equal(result!.boundedByColour, true);
});

test('box suggest stays inside the drag rectangle', () => {
  const data = paint(100, 80, (x, y) => {
    // Nested blob: outer gray, inner orange square 20..60
    if (x >= 20 && x < 60 && y >= 15 && y < 55) return [230, 140, 40];
    return [90, 90, 95];
  });
  const result = suggestRegionFromBox(data, 100, 80, { x: 18, y: 12, width: 50, height: 50 }, { colourTolerance: 60 });
  assert.ok(result);
  assert.ok(result!.pixels > 100);
  if (result!.shape.type === 'polygon') {
    for (const p of result!.shape.points) {
      assert.ok(p.x >= 15 && p.x <= 72, `point escaped box: ${JSON.stringify(p)}`);
      assert.ok(p.y >= 10 && p.y <= 65, `point escaped box: ${JSON.stringify(p)}`);
    }
  }
});


test('multi-prompt positives union and negatives carve', () => {
  const data = paint(80, 60, (x) => (x < 45 ? [210, 50, 40] : [40, 180, 60]));
  const withNeg = suggestRegionFromPrompts(data, 80, 60, [
    { x: 12, y: 30, label: 1 },
    { x: 20, y: 20, label: 1 },
    { x: 38, y: 30, label: 0 },
  ], { edgeBarrier: 0.2, colourTolerance: 50, negativeRadius: 6 });
  assert.ok(withNeg);
  const onlyPos = suggestRegionFromPrompts(data, 80, 60, [
    { x: 12, y: 30, label: 1 },
    { x: 20, y: 20, label: 1 },
  ], { edgeBarrier: 0.2, colourTolerance: 50 });
  assert.ok(onlyPos);
  assert.ok(withNeg!.pixels < onlyPos!.pixels, `neg should carve: ${withNeg!.pixels} vs ${onlyPos!.pixels}`);
});
