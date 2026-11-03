import test from 'node:test';
import assert from 'node:assert/strict';
import { computeChannelDiff, paintDiffHeatmap } from './canvas-diff.js';

test('identical frames report zero change', () => {
  const frame = new Uint8Array(4 * 4 * 4).fill(120);
  const stats = computeChannelDiff(frame, frame, 4, 4);
  assert.equal(stats.changedPixels, 0);
  assert.equal(stats.maxChannelDelta, 0);
});

test('channel delta heatmap marks only changed pixels', () => {
  const base = new Uint8Array(2 * 2 * 4);
  const cand = new Uint8Array(2 * 2 * 4);
  for (let i = 0; i < 4; i++) { base[i * 4] = 10; base[i * 4 + 1] = 10; base[i * 4 + 2] = 10; base[i * 4 + 3] = 255; }
  cand.set(base);
  cand[0] = 200; // pixel 0 red channel
  const stats = computeChannelDiff(base, cand, 2, 2);
  assert.equal(stats.changedPixels, 1);
  assert.equal(stats.maxChannelDelta, 190);
  assert.equal(stats.deltaMap[0], 190);
  assert.equal(stats.deltaMap[1], 0);
  const rgba = new Uint8Array(2 * 2 * 4);
  paintDiffHeatmap(stats.deltaMap, stats.maxChannelDelta, rgba);
  assert.ok(rgba[3] > 0);
  assert.equal(rgba[7], 0);
});
