import { useCallback, useEffect, useRef, useState } from 'react';
import type { Point, Region, Shape } from '../packages/shared/types';
import { imageGeometry, sourcePoint, screenPoint, type View } from './canvas-geometry';
import { renderMasks, EDIT_COLOR, KEEP_COLOR } from './canvas-render';
import { buildEdgeMap, snapToEdge, traceEdge, type EdgeMap } from './magnetic-lasso';

export type Tool = 'select' | 'brush' | 'erase' | 'rect' | 'polygon' | 'magnetic' | 'lasso' | 'move';
export type AnnotationKind = 'edit' | 'keep';
interface CanvasEditorProps {
  imageUrl: string; width: number; height: number; regions: Region[];
  activeRegionId: string | null; annotationKind: AnnotationKind; tool: Tool;
  brushSize: number; showMasks: boolean;
  onShape: (regionId: string | null, kind: AnnotationKind, shape: Shape) => void;
  onRegionSelect?: (id: string) => void;
  onToolChange?: (tool: Tool) => void;
  onBrushSizeChange?: (size: number) => void;
}
interface Draft {
  tool: Tool; start: Point; end: Point; points: Point[]; radius: number;
  regionId: string | null; kind: AnnotationKind;
}
interface Lasso {
  tool: 'magnetic' | 'polygon'; points: Point[]; preview: Point[]; anchors: number[];
  regionId: string | null; kind: AnnotationKind;
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
function containsShape(shape: Shape, point: Point): boolean {
  if (shape.type === 'rect') {
    const left = Math.min(shape.x, shape.x + shape.width);
    const top = Math.min(shape.y, shape.y + shape.height);
    return point.x >= left && point.x <= left + Math.abs(shape.width) && point.y >= top && point.y <= top + Math.abs(shape.height);
  }
  if (shape.type === 'polygon') {
    let inside = false;
    for (let i = 0, j = shape.points.length - 1; i < shape.points.length; j = i++) {
      const a = shape.points[i];
      const b = shape.points[j];
      const crosses = (a.y > point.y) !== (b.y > point.y) && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (crosses) inside = !inside;
    }
    return inside;
  }
  if (shape.points.length === 1) return Math.hypot(point.x - shape.points[0].x, point.y - shape.points[0].y) <= shape.radius;
  for (let i = 1; i < shape.points.length; i++) {
    const a = shape.points[i - 1];
    const b = shape.points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared ? Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
    if (Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)) <= shape.radius) return true;
  }
  return false;
}

function containsRegion(region: Region, point: Point): boolean {
  let inside = false;
  for (const shape of region.shapes) {
    if (containsShape(shape, point)) inside = !shape.subtract;
  }
  return inside;
}


function draftShape(draft: Draft): Shape | null {
  if (draft.tool === 'rect') {
    const width = Math.abs(draft.end.x - draft.start.x), height = Math.abs(draft.end.y - draft.start.y);
    return width >= 1 && height >= 1 ? { type: 'rect', x: Math.min(draft.start.x, draft.end.x), y: Math.min(draft.start.y, draft.end.y), width, height } : null;
  }
  if (draft.tool === 'lasso') return draft.points.length >= 3 ? { type: 'polygon', points: draft.points } : null;
  return { type: 'brush', points: draft.points, radius: draft.radius, ...(draft.tool === 'erase' ? { subtract: true } : {}) };
}

export function CanvasEditor(props: CanvasEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const maskRef = useRef<HTMLCanvasElement | null>(null);
  const tintRef = useRef<HTMLCanvasElement | null>(null);
  const edgeRef = useRef<EdgeMap | null>(null);
  const viewRef = useRef<View>({ scale: null, panX: 0, panY: 0 });
  const viewportRef = useRef({ width: 0, height: 0, dpr: 1 });
  const draftRef = useRef<Draft | null>(null);
  const lassoRef = useRef<Lasso | null>(null);
  const pointerRef = useRef<Point | null>(null);
  const dragRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const spaceRef = useRef(false);
  const propsRef = useRef(props); propsRef.current = props;
  const rafRef = useRef<number | null>(null);
  const [zoomLabel, setZoomLabel] = useState('适合');
  const [fitLabel, setFitLabel] = useState('…');
  const [lassoCount, setLassoCount] = useState(0);
  const [edgeError, setEdgeError] = useState('');
  const [snapRadius, setSnapRadius] = useState(14);
  const [contrast, setContrast] = useState(12);
  const optionsRef = useRef({ snapRadius, contrast }); optionsRef.current = { snapRadius, contrast };

  const geometry = useCallback(() => {
    const v = viewportRef.current, p = propsRef.current;
    return imageGeometry(v.width, v.height, p.width, p.height, viewRef.current);
  }, []);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const canvas = canvasRef.current, image = imageRef.current, p = propsRef.current;
      if (!canvas || !image?.complete || !image.naturalWidth) return;
      const g = geometry(), { dpr } = viewportRef.current;
      if (!g.width || !g.height) return;
      const ctx = canvas.getContext('2d')!;
      const sx = canvas.width / g.width, sy = canvas.height / g.height;
      ctx.setTransform(sx, 0, 0, sy, 0, 0);
      ctx.clearRect(0, 0, g.width, g.height);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(image, g.x, g.y, p.width * g.scale, p.height * g.scale);
      const context = p.regions.find(region => region.id === p.activeRegionId)?.context;
      if (p.showMasks && context) {
        ctx.save(); ctx.strokeStyle = '#4d7276'; ctx.lineWidth = 1; ctx.setLineDash([7, 4]);
        ctx.strokeRect(g.x + context.x * g.scale, g.y + context.y * g.scale, context.width * g.scale, context.height * g.scale);
        ctx.setLineDash([]); ctx.fillStyle = '#395b5e'; ctx.font = '11px sans-serif';
        ctx.fillText('模型观察范围', g.x + context.x * g.scale + 5, g.y + context.y * g.scale + 15);
        ctx.restore();
      }
      const draft = draftRef.current;
      const shape = draft ? draftShape(draft) : null;
      let displayRegions = p.regions;
      if (shape && draft) {
        // Preview is the exact same add/subtract operation as the committed stroke.
        // In particular erasing modifies the temporary active-region mask now.
        const active = p.regions.find(r => r.id === draft.regionId);
        displayRegions = active ? p.regions.map(r => r.id === active.id ? { ...r, shapes: [...r.shapes, shape] } : r)
          : [...p.regions, { id: 'preview', name: '', kind: draft.kind, intent: '', feather: 0, shapes: [shape] }];
      }
      if (p.showMasks || draft) {
        maskRef.current ??= document.createElement('canvas'); tintRef.current ??= document.createElement('canvas');
        renderMasks(ctx, maskRef.current, tintRef.current, displayRegions, g, dpr, p.width, p.height);
      }
      const lasso = lassoRef.current;
      const line = lasso ? [...lasso.points, ...lasso.preview.slice(1)] : draft?.tool === 'lasso' ? draft.points : [];
      if (line.length) {
        ctx.save(); ctx.translate(g.x, g.y); ctx.scale(g.scale, g.scale);
        ctx.beginPath(); ctx.moveTo(line[0].x, line[0].y);
        for (const point of line.slice(1)) ctx.lineTo(point.x, point.y);
        ctx.strokeStyle = '#222'; ctx.lineWidth = 3 / g.scale; ctx.stroke();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5 / g.scale; ctx.setLineDash([5 / g.scale, 4 / g.scale]); ctx.stroke(); ctx.setLineDash([]);
        if (lasso) for (const index of lasso.anchors) {
          const a = lasso.points[index]; if (!a) continue;
          ctx.fillStyle = '#fff'; ctx.strokeStyle = EDIT_COLOR; ctx.lineWidth = 1 / g.scale;
          ctx.beginPath(); ctx.arc(a.x, a.y, 3 / g.scale, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        ctx.restore();
      }
      const pointer = pointerRef.current;
      if (pointer && (p.tool === 'brush' || p.tool === 'erase' || p.tool === 'magnetic')) {
        const point = screenPoint(pointer, g);
        const radius = p.tool === 'magnetic' ? optionsRef.current.snapRadius : (draft?.radius ?? p.brushSize / 2) * g.scale;
        ctx.save();
        ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
        ctx.strokeStyle = '#000c'; ctx.lineWidth = 3; ctx.stroke();
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(point.x - 3, point.y); ctx.lineTo(point.x + 3, point.y);
        ctx.moveTo(point.x, point.y - 3); ctx.lineTo(point.x, point.y + 3);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
      }
    });
  }, [geometry]);

  useEffect(() => {
    const stage = stageRef.current; if (!stage) return;
    const resize = () => {
      const canvas = canvasRef.current; if (!canvas) return;
      const rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      viewportRef.current = { width: rect.width, height: rect.height, dpr };
      canvas.width = Math.max(1, Math.round(rect.width * dpr)); canvas.height = Math.max(1, Math.round(rect.height * dpr));
      if (rect.width && rect.height) setFitLabel(`${Math.round(imageGeometry(rect.width, rect.height, propsRef.current.width, propsRef.current.height, { scale: null, panX: 0, panY: 0 }).scale * 100)}%`);
      scheduleDraw();
    };
    const observer = new ResizeObserver(resize); observer.observe(stage);
    window.addEventListener('resize', resize);
    let media: MediaQueryList;
    const watchDpr = () => { media?.removeEventListener('change', watchDpr); resize(); media = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`); media.addEventListener('change', watchDpr); };
    watchDpr();
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); media?.removeEventListener('change', watchDpr); };
  }, [props.imageUrl, scheduleDraw]);

  useEffect(() => {
    let live = true;
    const image = new Image(); edgeRef.current = null; imageRef.current = null;
    image.onload = () => { if (live) { imageRef.current = image; setEdgeError(''); scheduleDraw(); } };
    image.onerror = () => { if (live) setEdgeError('照片无法载入，请重新打开项目。'); };
    image.src = props.imageUrl;
    return () => { live = false; image.onload = null; image.onerror = null; };
  }, [props.imageUrl, scheduleDraw]);

  useEffect(() => { scheduleDraw(); }, [props.regions, props.activeRegionId, props.showMasks, props.tool, props.brushSize, snapRadius, contrast, scheduleDraw]);
  useEffect(() => {
    draftRef.current = null; lassoRef.current = null; dragRef.current = null; setLassoCount(0); scheduleDraw();
  }, [props.tool, props.activeRegionId, props.imageUrl, scheduleDraw]);
  useEffect(() => () => { if (rafRef.current !== null) cancelAnimationFrame(rafRef.current); rafRef.current = null; }, []);

  const ensureEdges = () => {
    if (edgeRef.current) return edgeRef.current;
    const image = imageRef.current; if (!image) return null;
    try {
      const factor = Math.min(1, 2048 / Math.max(props.width, props.height));
      const width = Math.max(1, Math.round(props.width * factor)), height = Math.max(1, Math.round(props.height * factor));
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(image, 0, 0, width, height);
      edgeRef.current = buildEdgeMap(ctx.getImageData(0, 0, width, height).data, width, height, props.width, props.height);
      return edgeRef.current;
    } catch { setEdgeError('边缘分析不可用，可切换自由套索继续标注。'); return null; }
  };
  const clampPoint = (point: Point) => ({ x: Math.max(0, Math.min(props.width, point.x)), y: Math.max(0, Math.min(props.height, point.y)) });
  const eventPoint = (event: { clientX: number; clientY: number }) => sourcePoint(event.clientX, event.clientY, canvasRef.current!.getBoundingClientRect(), geometry());
  const commitPath = (lasso: Lasso, path: Point[]) => {
    const points = [...lasso.points, ...path.slice(1)];
    if (points.length > 9000) { setEdgeError('套索过长，请分段选取或使用画笔修正。'); return false; }
    lasso.points = points; lasso.anchors.push(points.length - 1); lasso.preview = [];
    setLassoCount(lasso.anchors.length); return true;
  };
  const updateLasso = (raw: Point, freehand: boolean, anchor = false) => {
    const lasso = lassoRef.current; if (!lasso) return;
    const start = lasso.points.at(-1)!;
    const map = lasso.tool === 'magnetic' && !freehand ? ensureEdges() : null;
    const radius = optionsRef.current.snapRadius / geometry().scale;
    const end = map ? snapToEdge(map, raw, radius, optionsRef.current.contrast / 100) : raw;
    lasso.preview = map ? traceEdge(map, start, end, radius, optionsRef.current.contrast / 100) : [start, end];
    if (anchor || lasso.tool === 'magnetic' && distance(start, end) * geometry().scale >= 16) commitPath(lasso, lasso.preview);
    scheduleDraw();
  };
  const finishLasso = () => {
    const lasso = lassoRef.current; if (!lasso) return;
    let points = [...lasso.points, ...lasso.preview.slice(1)];
    if (lasso.tool === 'magnetic' && points.length > 2) {
      const map = ensureEdges();
      if (map) points.push(...traceEdge(map, points.at(-1)!, points[0], optionsRef.current.snapRadius / geometry().scale, optionsRef.current.contrast / 100).slice(1));
    }
    lassoRef.current = null; setLassoCount(0);
    if (points.length >= 3 && points.length <= 10000) propsRef.current.onShape(lasso.regionId, lasso.kind, { type: 'polygon', points });
    else if (points.length > 10000) setEdgeError('套索过长，请分段选取。');
    scheduleDraw();
  };
  const cancel = () => { draftRef.current = null; lassoRef.current = null; dragRef.current = null; setLassoCount(0); scheduleDraw(); };

  const applyZoom = useCallback((scale: number | null, anchor?: Point) => {
    const g = geometry(), p = propsRef.current;
    if (scale === null) { viewRef.current = { scale: null, panX: 0, panY: 0 }; setZoomLabel('适合'); }
    else {
      const next = Math.min(8, Math.max(0.02, scale));
      const at = anchor ?? { x: g.width / 2, y: g.height / 2 };
      const source = { x: (at.x - g.x) / g.scale, y: (at.y - g.y) / g.scale };
      viewRef.current = { scale: next, panX: at.x - (g.width - p.width * next) / 2 - source.x * next, panY: at.y - (g.height - p.height * next) / 2 - source.y * next };
      setZoomLabel(`${Math.round(next * 100)}%`);
    }
    scheduleDraw();
  }, [geometry, scheduleDraw]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); if (draftRef.current || lassoRef.current) return; const r = canvas.getBoundingClientRect(); applyZoom(geometry().scale * Math.exp(-event.deltaY * 0.0015), { x: event.clientX - r.left, y: event.clientY - r.top }); };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => canvas.removeEventListener('wheel', wheel);
  }, [props.imageUrl, applyZoom, geometry]);

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const p = propsRef.current, raw = eventPoint(event);
    event.currentTarget.focus();
    if (p.tool === 'move' || spaceRef.current || event.button === 1) {
      dragRef.current = { x: event.clientX, y: event.clientY, panX: viewRef.current.panX, panY: viewRef.current.panY };
      event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); return;
    }
    if (raw.x < 0 || raw.y < 0 || raw.x > p.width || raw.y > p.height || !imageRef.current) return;
    const point = clampPoint(raw); pointerRef.current = point;
    if (p.tool === 'select') {
      const hit = [...p.regions].reverse().find(r => containsRegion(r, point)); if (hit) p.onRegionSelect?.(hit.id); return;
    }
    if (p.tool === 'erase' && !p.regions.some(r => r.id === p.activeRegionId)) { setEdgeError('先选择要擦除的区域，再使用橡皮。'); return; }
    setEdgeError('');
    if (p.tool === 'magnetic' || p.tool === 'polygon') {
      const lasso = lassoRef.current;
      if (lasso && (event.detail >= 2 || lasso.points.length >= 3 && distance(lasso.points[0], point) * geometry().scale < 7)) { finishLasso(); return; }
      if (lasso) updateLasso(point, event.altKey, true);
      else {
        const map = p.tool === 'magnetic' && !event.altKey ? ensureEdges() : null;
        const start = map ? snapToEdge(map, point, optionsRef.current.snapRadius / geometry().scale, optionsRef.current.contrast / 100) : point;
        lassoRef.current = { tool: p.tool, points: [start], preview: [], anchors: [0], regionId: p.activeRegionId, kind: p.annotationKind }; setLassoCount(1);
      }
      scheduleDraw(); return;
    }
    if (['brush', 'erase', 'rect', 'lasso'].includes(p.tool)) {
      draftRef.current = { tool: p.tool, start: point, end: point, points: [point], radius: p.brushSize / 2, regionId: p.activeRegionId, kind: p.annotationKind };
      event.currentTarget.setPointerCapture(event.pointerId); scheduleDraw();
    }
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag) { viewRef.current.panX = drag.panX + event.clientX - drag.x; viewRef.current.panY = drag.panY + event.clientY - drag.y; scheduleDraw(); return; }
    const raw = eventPoint(event);
    pointerRef.current = raw.x >= 0 && raw.y >= 0 && raw.x <= props.width && raw.y <= props.height ? raw : null;
    const point = clampPoint(raw), draft = draftRef.current;
    if (lassoRef.current) { updateLasso(point, event.altKey); return; }
    if (draft) {
      const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [event.nativeEvent]) {
        const next = clampPoint(eventPoint(sample)); draft.end = next;
        if (draft.tool !== 'rect' && distance(draft.points.at(-1)!, next) >= Math.max(0.35, Math.min(2, draft.radius / 8))) {
          if (draft.points.length < 9500) draft.points.push(next);
        }
      }
    }
    scheduleDraw();
  };
  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    const draft = draftRef.current; if (!draft) return;
    const point = clampPoint(eventPoint(event)); draft.end = point;
    if (draft.tool !== 'rect' && distance(draft.points.at(-1)!, point) > 0.05) draft.points.push(point);
    draftRef.current = null;
    const shape = draftShape(draft); if (shape) propsRef.current.onShape(draft.regionId, draft.kind, shape);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    scheduleDraw();
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    if (event.key === ' ') { event.preventDefault(); spaceRef.current = true; }
    if (event.key === 'Enter' && lassoRef.current) { event.preventDefault(); finishLasso(); }
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    if (event.key === 'Backspace' && lassoRef.current) {
      event.preventDefault(); const lasso = lassoRef.current;
      if (lasso.anchors.length <= 1) cancel();
      else { lasso.anchors.pop(); lasso.points = lasso.points.slice(0, lasso.anchors.at(-1)! + 1); lasso.preview = []; setLassoCount(lasso.anchors.length); scheduleDraw(); }
    }
    if ((event.key === '[' || event.key === ']') && (props.tool === 'brush' || props.tool === 'erase')) {
      event.preventDefault(); props.onBrushSizeChange?.(Math.max(1, Math.min(512, props.brushSize + (event.key === '[' ? -4 : 4))));
    }
  };
  const isLasso = ['magnetic', 'polygon', 'lasso'].includes(props.tool);
  return <div className={`canvas-stage tool-${props.tool}`} ref={stageRef}>
    {props.imageUrl ? <canvas ref={canvasRef} className="stage-canvas" aria-label="照片标注画布" tabIndex={0}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={cancel} onLostPointerCapture={() => { if (draftRef.current) cancel(); }}
      onPointerLeave={() => { pointerRef.current = null; scheduleDraw(); }}
      onKeyDown={onKeyDown} onKeyUp={e => { if (e.key === ' ') spaceRef.current = false; }} onBlur={() => { spaceRef.current = false; }}
      onDoubleClick={e => { if (lassoRef.current) { e.preventDefault(); finishLasso(); } }} />
      : <div className="canvas-empty"><strong>画布等待照片</strong><span>导入照片或从项目入口选择一个项目</span></div>}
    {props.imageUrl && (props.tool === 'brush' || props.tool === 'erase') && <div className="canvas-tool-options" aria-label="笔刷选项">
      <strong>{props.tool === 'erase' ? '橡皮' : '画笔'}</strong><label>直径 <input aria-label="笔刷直径" type="range" min="1" max="512" value={props.brushSize} onChange={e => props.onBrushSizeChange?.(Number(e.target.value))} /></label><span>{props.brushSize} px</span><small>[ ] 调整大小</small>
    </div>}
    {props.imageUrl && isLasso && <div className="canvas-tool-options lasso-options" aria-label="套索选项">
      <select aria-label="套索模式" value={props.tool} onChange={e => props.onToolChange?.(e.target.value as Tool)}><option value="magnetic">磁性套索</option><option value="lasso">自由套索</option><option value="polygon">多边形套索</option></select>
      {props.tool === 'magnetic' && <><label>吸附范围 <input aria-label="磁性吸附范围" type="range" min="4" max="40" value={snapRadius} onChange={e => setSnapRadius(Number(e.target.value))} /></label><span>{snapRadius} px</span><label>边缘对比 <input aria-label="边缘对比" type="range" min="2" max="80" value={contrast} onChange={e => setContrast(Number(e.target.value))} /></label><span>{contrast}%</span></>}
    </div>}
    {props.imageUrl && <div className="zoom-dock" aria-label="画布缩放">
      <button type="button" aria-label="缩小" onClick={() => applyZoom(geometry().scale / 1.2)}>−</button><button type="button" className="zoom-fit" onClick={() => applyZoom(null)}>适合</button>
      <span className="zoom-value">{zoomLabel === '适合' ? fitLabel : zoomLabel}</span>
      <button type="button" className="zoom-fit" onClick={() => applyZoom(1)}>100%</button><button type="button" aria-label="放大" onClick={() => applyZoom(geometry().scale * 1.2)}>＋</button>
    </div>}
    {(edgeError || isLasso) && <div className="canvas-hint" role="status">{edgeError || (props.tool === 'lasso' ? '按住拖画，松开闭合 · Esc 取消' : lassoCount ? `已设 ${lassoCount} 个锚点 · 移动贴边 · 点击加点 · Backspace 回退 · Enter 闭合 · Alt 暂停吸附` : '点击起点后沿边缘移动 · Enter / 双击 / 回到起点闭合')}</div>}
  </div>;
}
