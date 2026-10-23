import type { Region, Shape } from '../packages/shared/types';
import type { Geometry } from './canvas-geometry';
import { inwardFeatherAlpha, rasterizeRegionMask } from './mask-morphology';

export const EDIT_COLOR = '#c9973f';
export const KEEP_COLOR = '#6886ab';
/** Context / reference range — dashed, never edit authorization. */
export const CONTEXT_COLOR = '#4d7276';

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

function paintKeepHatch(t: CanvasRenderingContext2D, pixelWidth: number, pixelHeight: number, dpr: number) {
  t.globalCompositeOperation = 'source-atop'; t.strokeStyle = '#ffffff88'; t.lineWidth = dpr;
  for (let x = -pixelHeight; x < pixelWidth; x += 12 * dpr) {
    t.beginPath(); t.moveTo(x, 0); t.lineTo(x + pixelHeight, pixelHeight); t.stroke();
  }
}

/**
 * Draw E/K overlays. When an edit region has feather > 0, also paint the
 * inward-feather alpha so annotators see the effective E−K soft rim live.
 * Raster preview is capped for large photos to keep the UI responsive.
 */
export function renderMasks(
  ctx: CanvasRenderingContext2D,
  mask: HTMLCanvasElement,
  tint: HTMLCanvasElement,
  regions: Region[],
  g: Geometry,
  dpr: number,
  imageWidth: number,
  imageHeight: number,
  options?: { activeRegionId?: string | null; previewFeather?: boolean },
) {
  const pixelWidth = Math.max(1, Math.round(g.width * dpr)), pixelHeight = Math.max(1, Math.round(g.height * dpr));
  if (mask.width !== pixelWidth || mask.height !== pixelHeight) { mask.width = pixelWidth; mask.height = pixelHeight; }
  if (tint.width !== pixelWidth || tint.height !== pixelHeight) { tint.width = pixelWidth; tint.height = pixelHeight; }
  const m = mask.getContext('2d')!, t = tint.getContext('2d')!;
  const sx = pixelWidth / g.width, sy = pixelHeight / g.height;
  const previewFeather = options?.previewFeather !== false;
  const maxFeatherPreview = 1_200_000;
  const canRasterPreview = imageWidth * imageHeight <= maxFeatherPreview;

  for (const region of [...regions].sort((a, b) => Number(a.kind === 'keep') - Number(b.kind === 'keep'))) {
    m.setTransform(1, 0, 0, 1, 0, 0); m.clearRect(0, 0, pixelWidth, pixelHeight);
    m.save();
    m.setTransform(sx, 0, 0, sy, 0, 0); m.translate(g.x, g.y); m.scale(g.scale, g.scale);
    m.beginPath(); m.rect(0, 0, imageWidth, imageHeight); m.clip();
    m.fillStyle = '#fff'; m.strokeStyle = '#fff';
    for (const shape of region.shapes) paintShape(m, shape);
    m.restore();

    const useFeatherPreview = previewFeather && region.kind === 'edit' && region.feather > 0 && region.shapes.length > 0 && canRasterPreview;
    if (useFeatherPreview) {
      const binary = rasterizeRegionMask(region.shapes, imageWidth, imageHeight);
      const alpha = inwardFeatherAlpha(binary, imageWidth, imageHeight, region.feather);
      const featherCanvas = document.createElement('canvas');
      featherCanvas.width = imageWidth; featherCanvas.height = imageHeight;
      const fctx = featherCanvas.getContext('2d')!;
      const image = fctx.createImageData(imageWidth, imageHeight);
      for (let i = 0; i < alpha.length; i++) {
        const o = i * 4;
        image.data[o] = 255; image.data[o + 1] = 255; image.data[o + 2] = 255; image.data[o + 3] = alpha[i];
      }
      fctx.putImageData(image, 0, 0);
      m.setTransform(1, 0, 0, 1, 0, 0); m.clearRect(0, 0, pixelWidth, pixelHeight);
      m.save();
      m.setTransform(sx, 0, 0, sy, 0, 0); m.translate(g.x, g.y); m.scale(g.scale, g.scale);
      m.drawImage(featherCanvas, 0, 0);
      m.restore();
    }

    t.setTransform(1, 0, 0, 1, 0, 0); t.globalCompositeOperation = 'source-over';
    t.clearRect(0, 0, pixelWidth, pixelHeight);
    t.fillStyle = region.kind === 'keep' ? KEEP_COLOR : EDIT_COLOR;
    t.fillRect(0, 0, pixelWidth, pixelHeight);
    t.globalCompositeOperation = 'destination-in'; t.drawImage(mask, 0, 0);
    if (region.kind === 'keep') paintKeepHatch(t, pixelWidth, pixelHeight, dpr);
    t.globalCompositeOperation = 'source-over';
    ctx.save(); ctx.setTransform(sx, 0, 0, sy, 0, 0);
    const isActive = options?.activeRegionId && region.id === options.activeRegionId;
    ctx.globalAlpha = region.kind === 'keep' ? (isActive ? 0.32 : 0.26) : useFeatherPreview ? (isActive ? 0.42 : 0.34) : (isActive ? 0.36 : 0.30);
    ctx.drawImage(tint, 0, 0, pixelWidth, pixelHeight, 0, 0, g.width, g.height);
    ctx.restore();

    // Active edit: marching-ants style outline so E is distinct from soft fill.
    if (isActive && region.kind === 'edit' && region.shapes.length) {
      ctx.save();
      ctx.setTransform(sx, 0, 0, sy, 0, 0);
      ctx.translate(g.x, g.y); ctx.scale(g.scale, g.scale);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2.4 / g.scale; ctx.setLineDash([5 / g.scale, 4 / g.scale]);
      for (const shape of region.shapes) strokeShapeOutline(ctx, shape);
      ctx.strokeStyle = EDIT_COLOR; ctx.lineWidth = 1.2 / g.scale; ctx.setLineDash([5 / g.scale, 4 / g.scale]);
      for (const shape of region.shapes) strokeShapeOutline(ctx, shape);
      ctx.restore();
    }
  }
}

function strokeShapeOutline(ctx: CanvasRenderingContext2D, shape: Shape) {
  ctx.beginPath();
  if (shape.type === 'rect') {
    ctx.rect(shape.x, shape.y, shape.width, shape.height); ctx.stroke();
  } else if (shape.type === 'polygon' && shape.points.length) {
    ctx.moveTo(shape.points[0].x, shape.points[0].y);
    for (const point of shape.points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.closePath(); ctx.stroke();
  } else if (shape.type === 'brush' && shape.points.length) {
    ctx.lineWidth = Math.max(ctx.lineWidth, 1.5);
    if (shape.points.length === 1) {
      ctx.arc(shape.points[0].x, shape.points[0].y, shape.radius, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.moveTo(shape.points[0].x, shape.points[0].y);
      for (const point of shape.points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
  }
}

export function drawContextRect(
  ctx: CanvasRenderingContext2D,
  g: Geometry,
  context: { x: number; y: number; width: number; height: number },
) {
  ctx.save();
  ctx.strokeStyle = CONTEXT_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([7, 4]);
  ctx.strokeRect(g.x + context.x * g.scale, g.y + context.y * g.scale, context.width * g.scale, context.height * g.scale);
  ctx.setLineDash([]);
  ctx.fillStyle = '#395b5e';
  ctx.font = '11px sans-serif';
  ctx.fillText('参考范围 · 非编辑授权', g.x + context.x * g.scale + 5, g.y + context.y * g.scale + 15);
  ctx.restore();
}
