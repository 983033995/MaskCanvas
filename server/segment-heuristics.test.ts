import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { autoSeeds, proposeRegionsFromImageBytes } from './segment-heuristics.js';

test('autoSeeds prefers distinct colour interiors', () => {
  const w = 120, h = 90;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const left = x < 50 && y > 10 && y < 80;
    rgba[o] = left ? 220 : 40;
    rgba[o + 1] = left ? 40 : 180;
    rgba[o + 2] = left ? 40 : 60;
    rgba[o + 3] = 255;
  }
  const seeds = autoSeeds(rgba, w, h, 3);
  assert.ok(seeds.length >= 1);
  assert.ok(seeds.every(s => s.label === 1));
});

test('proposeRegionsFromImageBytes returns non-overlapping draft regions', async () => {
  const png = await sharp({
    create: {
      width: 160,
      height: 120,
      channels: 3,
      background: { r: 30, g: 30, b: 35 },
    },
  })
    .composite([
      { input: await sharp({ create: { width: 50, height: 50, channels: 3, background: { r: 220, g: 60, b: 40 } } }).png().toBuffer(), left: 12, top: 20 },
      { input: await sharp({ create: { width: 45, height: 45, channels: 3, background: { r: 40, g: 170, b: 70 } } }).png().toBuffer(), left: 95, top: 55 },
    ])
    .png()
    .toBuffer();

  const found = await proposeRegionsFromImageBytes(png, { maxRegions: 3 });
  assert.equal(found.engine, 'heuristic');
  assert.ok(found.proposals.length >= 1, `expected regions, got ${found.proposals.length}`);
  for (const item of found.proposals) {
    assert.equal(item.region.kind, 'edit');
    assert.equal(item.region.shapes[0]?.type, 'polygon');
    assert.ok(item.confidence > 0 && item.confidence <= 1);
    assert.ok(item.pixels > 50);
  }
});

test('hints in original coordinates are honoured', async () => {
  const png = await sharp({
    create: { width: 100, height: 80, channels: 3, background: { r: 20, g: 20, b: 20 } },
  })
    .composite([
      { input: await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 200, g: 50, b: 50 } } }).png().toBuffer(), left: 10, top: 15 },
    ])
    .png()
    .toBuffer();
  const found = await proposeRegionsFromImageBytes(png, {
    maxRegions: 1,
    hints: [{ x: 25, y: 30, label: 1 }],
  });
  assert.ok(found.proposals.length >= 1);
  assert.ok(found.proposals[0].seed.x < 60);
});
