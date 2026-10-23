import type { Region } from '../packages/shared/types';

export interface AnnotateSnapshot {
  regions: Region[];
  selectedRegionId: string | null;
}

const MAX_HISTORY = 60;

function cloneRegions(regions: Region[]): Region[] {
  return regions.map(region => ({
    ...region,
    shapes: region.shapes.map(shape => {
      if (shape.type === 'rect') return { ...shape };
      if (shape.type === 'brush') return { ...shape, points: shape.points.map(p => ({ ...p })) };
      return { ...shape, points: shape.points.map(p => ({ ...p })) };
    }),
    context: region.context ? { ...region.context } : undefined,
  }));
}

export function cloneSnapshot(snapshot: AnnotateSnapshot): AnnotateSnapshot {
  return {
    regions: cloneRegions(snapshot.regions),
    selectedRegionId: snapshot.selectedRegionId,
  };
}

export function snapshotsEqual(a: AnnotateSnapshot, b: AnnotateSnapshot): boolean {
  return a.selectedRegionId === b.selectedRegionId && JSON.stringify(a.regions) === JSON.stringify(b.regions);
}

/**
 * Linear undo/redo stack for annotate edits (regions + selection).
 * Call `push` after user mutations; `replacePresent` when syncing from server.
 */
export class AnnotateHistory {
  private past: AnnotateSnapshot[] = [];
  private present: AnnotateSnapshot;
  private future: AnnotateSnapshot[] = [];

  constructor(initial: AnnotateSnapshot) {
    this.present = cloneSnapshot(initial);
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get current(): AnnotateSnapshot { return cloneSnapshot(this.present); }
  get undoDepth(): number { return this.past.length; }
  get redoDepth(): number { return this.future.length; }

  /** Reset stack to a remote/loaded state without keeping old past/future. */
  replacePresent(next: AnnotateSnapshot): AnnotateSnapshot {
    this.past = [];
    this.future = [];
    this.present = cloneSnapshot(next);
    return this.current;
  }

  /** Push present onto past if `next` differs, clear redo. */
  push(next: AnnotateSnapshot): AnnotateSnapshot {
    const cloned = cloneSnapshot(next);
    if (snapshotsEqual(this.present, cloned)) return this.current;
    this.past.push(this.present);
    if (this.past.length > MAX_HISTORY) this.past.shift();
    this.present = cloned;
    this.future = [];
    return this.current;
  }

  undo(): AnnotateSnapshot | null {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(this.present);
    this.present = previous;
    return this.current;
  }

  redo(): AnnotateSnapshot | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(this.present);
    this.present = next;
    return this.current;
  }
}
