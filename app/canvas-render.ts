import type { Region, Shape } from '../packages/shared/types';
import type { Geometry } from './canvas-geometry';

export const EDIT_COLOR = '#c9973f';
export const KEEP_COLOR = '#6886ab';

export function paintShape(ctx: CanvasRenderingContext2D, shape: Shape) {
  ctx.globalCompositeOperation = shape.subtract ? 'destination-out' : 'source-over';
  ctx.beginPath();
  if (shape.type === 'rect') {
    ctx.rect(shape.x, shape.y, shape.width, shape.height); ctx.fill();
  } else if (shape.type === 'polygon') {
    if (!shape.points.length) return;
    ctx.moveTo(shape.points[0].x, shape.points[0].y);
    for (const point of shape.points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.closePath(); ctx.fill();
  } else {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = shape.radius * 2;
    if (shape.points.length === 1) {
      ctx.arc(shape.points[0].x, shape.points[0].y, shape.radius, 0, Math.PI * 2); ctx.fill();
    } else if (shape.points.length) {
      ctx.moveTo(shape.points[0].x, shape.points[0].y);
      for (const point of shape.points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
  }
}

export function renderMasks(ctx: CanvasRenderingContext2D, mask: HTMLCanvasElement, tint: HTMLCanvasElement, regions: Region[], g: Geometry, dpr: number, imageWidth: number, imageHeight: number) {
  const pixelWidth = Math.max(1, Math.round(g.width * dpr)), pixelHeight = Math.max(1, Math.round(g.height * dpr));
  if (mask.width !== pixelWidth || mask.height !== pixelHeight) { mask.width = pixelWidth; mask.height = pixelHeight; }
  if (tint.width !== pixelWidth || tint.height !== pixelHeight) { tint.width = pixelWidth; tint.height = pixelHeight; }
  const m = mask.getContext('2d')!, t = tint.getContext('2d')!;
  const sx = pixelWidth / g.width, sy = pixelHeight / g.height;
  for (const region of [...regions].sort((a, b) => Number(a.kind === 'keep') - Number(b.kind === 'keep'))) {
    m.setTransform(1, 0, 0, 1, 0, 0); m.clearRect(0, 0, pixelWidth, pixelHeight);
    m.save();
    m.setTransform(sx, 0, 0, sy, 0, 0); m.translate(g.x, g.y); m.scale(g.scale, g.scale);
    m.beginPath(); m.rect(0, 0, imageWidth, imageHeight); m.clip();
    m.fillStyle = '#fff'; m.strokeStyle = '#fff';
    for (const shape of region.shapes) paintShape(m, shape);
    m.restore();
    // mask/tint are already device-pixel bitmaps. Composite them at IDENTITY,
    // otherwise DPR is applied twice and masks drift away from the pointer.
    t.setTransform(1, 0, 0, 1, 0, 0); t.globalCompositeOperation = 'source-over';
    t.clearRect(0, 0, pixelWidth, pixelHeight);
    t.fillStyle = region.kind === 'keep' ? KEEP_COLOR : EDIT_COLOR;
    t.fillRect(0, 0, pixelWidth, pixelHeight);
    t.globalCompositeOperation = 'destination-in'; t.drawImage(mask, 0, 0);
    if (region.kind === 'keep') {
      t.globalCompositeOperation = 'source-atop'; t.strokeStyle = '#ffffff88'; t.lineWidth = dpr;
      for (let x = -pixelHeight; x < pixelWidth; x += 12 * dpr) {
        t.beginPath(); t.moveTo(x, 0); t.lineTo(x + pixelHeight, pixelHeight); t.stroke();
      }
    }
    t.globalCompositeOperation = 'source-over';
    ctx.save(); ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.globalAlpha = region.kind === 'keep' ? 0.26 : 0.30;
    ctx.drawImage(tint, 0, 0, pixelWidth, pixelHeight, 0, 0, g.width, g.height);
    ctx.restore();
  }
}
