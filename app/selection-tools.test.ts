import test from 'node:test';
import assert from 'node:assert/strict';
import { imageGeometry, sourcePoint, screenPoint } from './canvas-geometry.js';
import { buildEdgeMap, snapToEdge, traceEdge } from './magnetic-lasso.js';

test('pointer round-trip stays in source pixels at fit/zoom/pan and CSS scaling', () => {
  for (const scale of [null, 0.25, 1, 2.5]) for (const panX of [0, -120, 60]) {
    const geometry = imageGeometry(960, 700, 1536, 1024, { scale, panX, panY: 35 });
    const point = { x: 321.25, y: 215.5 }, screen = screenPoint(point, geometry);
    for (const cssScale of [1, 0.8, 1.5]) {
      const rect = { left: 76, top: 62, width: 960 * cssScale, height: 700 * cssScale };
      const restored = sourcePoint(rect.left + screen.x * cssScale, rect.top + screen.y * cssScale, rect, geometry);
      assert.ok(Math.abs(restored.x - point.x) < 1e-7); assert.ok(Math.abs(restored.y - point.y) < 1e-7);
    }
  }
});

function fixture(width: number, height: number, colour: (x: number, y: number) => number[]) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set([...colour(x, y), 255], (y * width + x) * 4);
  return buildEdgeMap(pixels, width, height);
}

test('magnetic endpoint snaps to a colour boundary and does not invent edges on a flat image', () => {
  const edge = fixture(100, 80, x => x < 50 ? [240, 20, 30] : [10, 190, 60]);
  const snapped = snapToEdge(edge, { x: 56, y: 25 }, 10, 0.12);
  assert.ok(Math.abs(snapped.x - 50) <= 1);
  assert.ok(Math.abs(snapped.y - 25) <= 1);
  const flat = fixture(100, 80, () => [160, 160, 160]);
  assert.deepEqual(snapToEdge(flat, { x: 22.5, y: 31.2 }, 10, 0.12), { x: 22.5, y: 31.2 });
  assert.deepEqual(traceEdge(flat, { x: 5.1, y: 5.1 }, { x: 5.2, y: 5.2 }, 10, 0.12), [{ x: 5.1, y: 5.1 }, { x: 5.2, y: 5.2 }]);
});

test('live-wire follows a bent edge instead of a straight polygon segment', () => {
  const edge = fixture(100, 100, (x, y) => x < 40 + Math.round(0.2 * Math.abs(y - 50)) ? [20, 30, 40] : [240, 240, 240]);
  const start = snapToEdge(edge, { x: 48, y: 15 }, 8, 0.12);
  const end = snapToEdge(edge, { x: 48, y: 85 }, 8, 0.12);
  const path = traceEdge(edge, start, end, 14, 0.12);
  assert.deepEqual(path[0], start); assert.deepEqual(path.at(-1), end);
  assert.ok(path.length > 20);
  const middle = path.filter(p => p.y >= 45 && p.y <= 55);
  assert.ok(middle.length > 0);
  assert.ok(middle.every(p => Math.abs(p.x - 40) <= 3), JSON.stringify(middle));
});

test('edge-map paths map back to full original image coordinates', () => {
  const small = fixture(100, 80, x => x < 50 ? [0, 0, 0] : [255, 255, 255]);
  small.imageWidth = 1000; small.imageHeight = 800;
  const snapped = snapToEdge(small, { x: 550, y: 250 }, 100, 0.12);
  assert.ok(Math.abs(snapped.x - 500) <= 10); assert.equal(snapped.y, 250);
});
