import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countMaskPixels,
  dilateMask,
  erodeMask,
  invertMask,
  inwardFeatherAlpha,
  morphRegionShapes,
  rasterizeRegionMask,
  featherCoreMask,
} from './mask-morphology.js';

test('rasterize rect and brush, subtract punches a hole', () => {
  const mask = rasterizeRegionMask([
    { type: 'rect', x: 2, y: 2, width: 6, height: 6 },
    { type: 'brush', points: [{ x: 5, y: 5 }], radius: 1, subtract: true },
  ], 10, 10);
  assert.equal(mask[2 * 10 + 2], 255);
  assert.equal(mask[5 * 10 + 5], 0);
  assert.ok(countMaskPixels(mask) < 36);
});

test('expand grows and contract shrinks a filled square', () => {
  const shapes = [{ type: 'rect' as const, x: 4, y: 4, width: 4, height: 4 }];
  const base = rasterizeRegionMask(shapes, 16, 16);
  const expanded = dilateMask(base, 16, 16, 1);
  const contracted = erodeMask(base, 16, 16, 1);
  assert.ok(countMaskPixels(expanded) > countMaskPixels(base));
  assert.ok(countMaskPixels(contracted) < countMaskPixels(base));
  assert.equal(expanded[3 * 16 + 3], 255);
  assert.equal(contracted[4 * 16 + 4], 0);
});

test('invert flips empty and full coverage', () => {
  const empty = invertMask(rasterizeRegionMask([], 4, 4));
  assert.equal(countMaskPixels(empty), 16);
  const full = invertMask(rasterizeRegionMask([{ type: 'rect', x: 0, y: 0, width: 4, height: 4 }], 4, 4));
  assert.equal(countMaskPixels(full), 0);
});

test('morphRegionShapes expand/contract/invert replace shapes and report pixel deltas', () => {
  const region = { shapes: [{ type: 'rect' as const, x: 8, y: 8, width: 8, height: 8 }] };
  const expanded = morphRegionShapes(region, 32, 32, 'expand', 2);
  assert.equal(expanded.empty, false);
  assert.ok(expanded.afterPixels > expanded.beforePixels);
  assert.equal(expanded.shapes[0].type, 'polygon');

  const contracted = morphRegionShapes(region, 32, 32, 'contract', 3);
  assert.ok(contracted.afterPixels < contracted.beforePixels);

  const inverted = morphRegionShapes(region, 32, 32, 'invert');
  assert.equal(inverted.beforePixels + inverted.afterPixels, 32 * 32);

  const gone = morphRegionShapes(region, 32, 32, 'contract', 20);
  assert.equal(gone.empty, true);
  assert.deepEqual(gone.shapes, []);
});

test('inward feather keeps core opaque and softens the rim', () => {
  const mask = rasterizeRegionMask([{ type: 'rect', x: 4, y: 4, width: 12, height: 12 }], 20, 20);
  const alpha = inwardFeatherAlpha(mask, 20, 20, 3);
  assert.equal(alpha[0], 0);
  assert.ok(alpha[10 * 20 + 10] >= 250, `core alpha ${alpha[10 * 20 + 10]}`);
  assert.ok(alpha[4 * 20 + 4] < alpha[10 * 20 + 10], 'rim softer than core');
  const core = featherCoreMask(mask, 20, 20, 3);
  assert.ok(countMaskPixels(core) < countMaskPixels(mask));
});
