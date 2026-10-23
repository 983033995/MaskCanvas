import test from 'node:test';
import assert from 'node:assert/strict';
import { AnnotateHistory } from './annotate-history.js';
import type { Region } from '../packages/shared/types.js';

const region = (id: string, shapes = 1): Region => ({
  id, name: id, kind: 'edit', intent: '', feather: 0,
  shapes: Array.from({ length: shapes }, (_, i) => ({ type: 'rect', x: i, y: 0, width: 4, height: 4 })),
});

test('undo/redo restores regions and clears opposite stack', () => {
  const history = new AnnotateHistory({ regions: [], selectedRegionId: null });
  history.push({ regions: [region('a')], selectedRegionId: 'a' });
  history.push({ regions: [region('a', 2)], selectedRegionId: 'a' });
  assert.equal(history.canUndo, true);
  const undone = history.undo();
  assert.ok(undone);
  assert.equal(undone!.regions[0].shapes.length, 1);
  assert.equal(history.canRedo, true);
  const redone = history.redo();
  assert.equal(redone!.regions[0].shapes.length, 2);
  assert.equal(history.canRedo, false);
});

test('replacePresent drops past and future', () => {
  const history = new AnnotateHistory({ regions: [], selectedRegionId: null });
  history.push({ regions: [region('a')], selectedRegionId: 'a' });
  history.replacePresent({ regions: [region('b')], selectedRegionId: 'b' });
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
  assert.equal(history.current.selectedRegionId, 'b');
});

test('identical push is ignored', () => {
  const history = new AnnotateHistory({ regions: [region('a')], selectedRegionId: 'a' });
  history.push({ regions: [region('a')], selectedRegionId: 'a' });
  assert.equal(history.undoDepth, 0);
});
