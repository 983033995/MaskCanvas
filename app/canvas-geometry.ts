import type { Point } from '../packages/shared/types';

export interface Geometry { width: number; height: number; scale: number; x: number; y: number }
export interface View { scale: number | null; panX: number; panY: number }

export function imageGeometry(width: number, height: number, imageWidth: number, imageHeight: number, view: View): Geometry {
  const fit = Math.max(0.001, Math.min((width - 48) / imageWidth, (height - 48) / imageHeight));
  const scale = view.scale ?? fit;
  return { width, height, scale, x: (width - imageWidth * scale) / 2 + view.panX, y: (height - imageHeight * scale) / 2 + view.panY };
}

// Pointer coordinates and view geometry stay in CSS pixels. DPR is ONLY a
// backing-store concern; CSS transforms are accounted for by the rect ratio.
export function sourcePoint(clientX: number, clientY: number, rect: { left: number; top: number; width: number; height: number }, geometry: Geometry): Point {
  return {
    x: ((clientX - rect.left) * geometry.width / rect.width - geometry.x) / geometry.scale,
    y: ((clientY - rect.top) * geometry.height / rect.height - geometry.y) / geometry.scale,
  };
}

export function screenPoint(point: Point, geometry: Geometry): Point {
  return { x: geometry.x + point.x * geometry.scale, y: geometry.y + point.y * geometry.scale };
}
