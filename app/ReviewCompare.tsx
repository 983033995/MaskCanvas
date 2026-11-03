import { useCallback, useEffect, useRef, useState } from 'react';
import type { Validation } from '../packages/shared/types';
import { computeChannelDiff, paintDiffHeatmap, type ReviewCompareMode } from './canvas-diff';

interface ReviewCompareProps {
  baseUrl: string;
  candidateUrl: string;
  width: number;
  height: number;
  mode: ReviewCompareMode;
  validation?: Validation;
  baseLabel?: string;
  candidateLabel?: string;
  onExit?: () => void;
}

/**
 * S06 review surface: wipe slider and diff heatmap over original-size assets.
 * Side-by-side stays in App; this component covers wipe + diff.
 */
export function ReviewCompare(props: ReviewCompareProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<HTMLImageElement | null>(null);
  const candRef = useRef<HTMLImageElement | null>(null);
  const diffRef = useRef<ImageData | null>(null);
  const [wipe, setWipe] = useState(0.5);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [localDiff, setLocalDiff] = useState<{ changed: number; max: number } | null>(null);
  const wipeRef = useRef(wipe); wipeRef.current = wipe;
  const modeRef = useRef(props.mode); modeRef.current = props.mode;
  const dragRef = useRef(false);

  const draw = useCallback(() => {
    const canvas = canvasRef.current, stage = stageRef.current;
    const base = baseRef.current, cand = candRef.current;
    if (!canvas || !stage || !base?.complete || !cand?.complete) return;
    const rect = stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(1, rect.width), cssH = Math.max(1, rect.height);
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`; canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const fit = Math.min(cssW / props.width, cssH / props.height);
    const dw = props.width * fit, dh = props.height * fit;
    const ox = (cssW - dw) / 2, oy = (cssH - dh) / 2;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';

    if (modeRef.current === 'wipe') {
      const split = ox + dw * wipeRef.current;
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, split, cssH); ctx.clip();
      ctx.drawImage(base, ox, oy, dw, dh);
      ctx.restore();
      ctx.save();
      ctx.beginPath(); ctx.rect(split, 0, cssW - split, cssH); ctx.clip();
      ctx.drawImage(cand, ox, oy, dw, dh);
      ctx.restore();
      ctx.fillStyle = '#fff';
      ctx.fillRect(split - 1, oy, 2, dh);
      ctx.strokeStyle = '#252622'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(split, oy); ctx.lineTo(split, oy + dh); ctx.stroke();
      // handle
      // Rounded wipe handle
      const hx = split - 11, hy = oy + dh / 2 - 20;
      ctx.fillStyle = 'rgb(37 38 34 / 92%)';
      ctx.beginPath();
      ctx.moveTo(hx + 4, hy); ctx.lineTo(hx + 18, hy); ctx.quadraticCurveTo(hx + 22, hy, hx + 22, hy + 4);
      ctx.lineTo(hx + 22, hy + 36); ctx.quadraticCurveTo(hx + 22, hy + 40, hx + 18, hy + 40);
      ctx.lineTo(hx + 4, hy + 40); ctx.quadraticCurveTo(hx, hy + 40, hx, hy + 36);
      ctx.lineTo(hx, hy + 4); ctx.quadraticCurveTo(hx, hy, hx + 4, hy); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillRect(split - 1, oy + dh / 2 - 12, 2, 24);
      ctx.fillRect(split - 4, oy + dh / 2 - 5, 8, 1.5);
      ctx.fillRect(split - 4, oy + dh / 2 + 3, 8, 1.5);
    } else {
      // diff heatmap over candidate
      ctx.drawImage(cand, ox, oy, dw, dh);
      if (diffRef.current) {
        const overlay = document.createElement('canvas');
        overlay.width = props.width; overlay.height = props.height;
        overlay.getContext('2d')!.putImageData(diffRef.current, 0, 0);
        ctx.drawImage(overlay, ox, oy, dw, dh);
      }
    }
  }, [props.width, props.height]);

  useEffect(() => {
    let live = true;
    setReady(false); setError(''); setLocalDiff(null); diffRef.current = null;
    const base = new Image(); const cand = new Image();
    base.crossOrigin = 'anonymous'; cand.crossOrigin = 'anonymous';
    let pending = 2;
    const done = () => {
      pending--;
      if (!live || pending) return;
      baseRef.current = base; candRef.current = cand;
      // Build heatmap at original resolution (downscale if huge for responsiveness).
      try {
        const maxSide = 1600;
        const scale = Math.min(1, maxSide / Math.max(props.width, props.height));
        const w = Math.max(1, Math.round(props.width * scale));
        const h = Math.max(1, Math.round(props.height * scale));
        const scratch = document.createElement('canvas');
        scratch.width = w; scratch.height = h;
        const sctx = scratch.getContext('2d', { willReadFrequently: true })!;
        sctx.drawImage(base, 0, 0, w, h);
        const baseData = sctx.getImageData(0, 0, w, h);
        sctx.clearRect(0, 0, w, h);
        sctx.drawImage(cand, 0, 0, w, h);
        const candData = sctx.getImageData(0, 0, w, h);
        const stats = computeChannelDiff(baseData.data, candData.data, w, h);
        const heat = sctx.createImageData(w, h);
        paintDiffHeatmap(stats.deltaMap, stats.maxChannelDelta, heat.data);
        // Upscale heat to full image size into ImageData via canvas
        const full = document.createElement('canvas');
        full.width = props.width; full.height = props.height;
        const fctx = full.getContext('2d')!;
        const heatCanvas = document.createElement('canvas');
        heatCanvas.width = w; heatCanvas.height = h;
        heatCanvas.getContext('2d')!.putImageData(heat, 0, 0);
        fctx.imageSmoothingEnabled = false;
        fctx.drawImage(heatCanvas, 0, 0, props.width, props.height);
        diffRef.current = fctx.getImageData(0, 0, props.width, props.height);
        setLocalDiff({ changed: Math.round(stats.changedPixels / (scale * scale)), max: stats.maxChannelDelta });
      } catch {
        setError('差异图无法计算（可能是跨域图片）。wipe 对比仍可用。');
      }
      setReady(true);
      draw();
    };
    base.onload = done; cand.onload = done;
    base.onerror = () => { if (live) setError('无法载入对比基准图。'); };
    cand.onerror = () => { if (live) setError('无法载入候选图。'); };
    base.src = props.baseUrl; cand.src = props.candidateUrl;
    return () => { live = false; base.onload = null; cand.onload = null; };
  }, [props.baseUrl, props.candidateUrl, props.width, props.height, draw]);

  useEffect(() => { draw(); }, [props.mode, wipe, ready, draw]);

  useEffect(() => {
    const stage = stageRef.current; if (!stage) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(stage);
    return () => ro.disconnect();
  }, [draw]);

  const onPointerDown = (event: React.PointerEvent) => {
    if (props.mode !== 'wipe') return;
    dragRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateWipe(event);
  };
  const updateWipe = (event: { clientX: number }) => {
    const stage = stageRef.current; if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const fit = Math.min(rect.width / props.width, rect.height / props.height);
    const dw = props.width * fit;
    const ox = (rect.width - dw) / 2;
    const t = (event.clientX - rect.left - ox) / dw;
    setWipe(Math.max(0.02, Math.min(0.98, t)));
  };
  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragRef.current || props.mode !== 'wipe') return;
    updateWipe(event);
  };
  const onPointerUp = () => { dragRef.current = false; };

  const protectOk = props.validation?.protectedChangedPixels === 0;
  const outsideOk = props.validation?.outsideEditChangedPixels === 0;

  return (
    <div className="review-compare" ref={stageRef}>
      <canvas
        ref={canvasRef}
        className="review-canvas"
        tabIndex={0}
        aria-label={props.mode === 'wipe' ? 'wipe 对比画布，左右方向键微调' : '差异热图画布'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={event => {
          if (props.mode !== 'wipe') return;
          if (event.key === 'ArrowLeft') { event.preventDefault(); setWipe(w => Math.max(0.02, w - 0.02)); }
          if (event.key === 'ArrowRight') { event.preventDefault(); setWipe(w => Math.min(0.98, w + 0.02)); }
        }}
      />
      <div className="review-overlay-labels" aria-hidden="true">
        <span className="review-label left">{props.baseLabel ?? '基准'}</span>
        <span className="review-label right">{props.candidateLabel ?? '候选'}</span>
      </div>
      <div className="review-badges" role="status">
        {props.validation ? (
          <>
            <span className={`review-badge ${protectOk ? 'ok' : 'bad'}`}>
              保护区变化 {props.validation.protectedChangedPixels.toLocaleString()} px
              {protectOk ? ' · 硬约束通过' : ' · 未通过'}
            </span>
            <span className={`review-badge ${outsideOk ? 'ok' : 'bad'}`}>
              编辑区外 {props.validation.outsideEditChangedPixels.toLocaleString()} px
            </span>
          </>
        ) : (
          <span className="review-badge unknown">服务端未返回保护区像素报告</span>
        )}
        {localDiff && props.mode === 'diff' && (
          <span className="review-badge info">热图变化约 {localDiff.changed.toLocaleString()} px · 最大通道差 {localDiff.max}</span>
        )}
      </div>
      {error && <div className="review-error" role="alert">{error}</div>}
      {!ready && !error && <div className="review-loading">正在准备对比…</div>}
      {props.onExit && <button type="button" className="compare-close review-exit" onClick={props.onExit}>退出对比</button>}
    </div>
  );
}

export type { ReviewCompareMode };
