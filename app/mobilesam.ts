/**
 * Lazy MobileSAM (onnxruntime-web) — encode-once / decode-per-prompt.
 * Falls back to null on missing assets, OOM, or any runtime failure so the
 * caller can keep using local multi-point heuristics.
 */
import type { Point } from '../packages/shared/types';
import { maskToPolygon, countMaskPixels, createMask, type MaskBuffer } from './mask-morphology';
import type { PromptPoint, SuggestResult } from './region-suggest';

export type MobileSamStatus = 'idle' | 'loading' | 'ready' | 'unavailable' | 'failed';

const MODEL_ROOT = '/models/mobilesam';
const ENCODER_URL = `${MODEL_ROOT}/mobile_sam_image_encoder.onnx`;
const DECODER_URL = `${MODEL_ROOT}/sam_mask_decoder_single.onnx`;
const TARGET = 1024;
const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

type OrtModule = typeof import('onnxruntime-web');
type InferenceSession = import('onnxruntime-web').InferenceSession;
type Tensor = import('onnxruntime-web').Tensor;

let ortPromise: Promise<OrtModule> | null = null;
let sessionPromise: Promise<{ enc: InferenceSession; dec: InferenceSession } | null> | null = null;

export interface MobileSamState {
  status: MobileSamStatus;
  detail: string;
  embeddingReady: boolean;
}

const state: MobileSamState = { status: 'idle', detail: '', embeddingReady: false };

let encoder: InferenceSession | null = null;
let decoder: InferenceSession | null = null;
let embedding: Tensor | null = null;
let embeddingKey = '';
let letterbox = { scale: 1, padX: 0, padY: 0, origW: 0, origH: 0, modelW: TARGET, modelH: TARGET };

export function getMobileSamState(): MobileSamState {
  return { ...state };
}

function isOom(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /out of memory|oom|Array buffer allocation|memory access|Failed to allocate|ENOMEM/i.test(text);
}

async function loadOrt(): Promise<OrtModule> {
  if (!ortPromise) {
    ortPromise = import('onnxruntime-web').then((ort) => {
      // Prefer locally copied WASM (app/public/ort); CDN fallback keeps install light.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      ort.env.wasm.wasmPaths = '/ort/';
      return ort;
    });
  }
  return ortPromise;
}

async function fetchModel(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`模型不可用 HTTP ${response.status}: ${url}`);
  return response.arrayBuffer();
}

export async function ensureMobileSam(): Promise<boolean> {
  if (encoder && decoder) {
    state.status = 'ready';
    return true;
  }
  if (state.status === 'failed' || state.status === 'unavailable') return false;
  if (!sessionPromise) {
    state.status = 'loading';
    state.detail = '正在载入 MobileSAM…';
    sessionPromise = (async () => {
      try {
        const probe = await fetch(ENCODER_URL, { method: 'HEAD', cache: 'force-cache' });
        if (!probe.ok) {
          state.status = 'unavailable';
          state.detail = '未安装 MobileSAM 权重（见 docs/sam2-deferred.md）';
          return null;
        }
        const ort = await loadOrt();
        const [encBuf, decBuf] = await Promise.all([fetchModel(ENCODER_URL), fetchModel(DECODER_URL)]);
        const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'basic' as const };
        const enc = await ort.InferenceSession.create(encBuf, opts);
        const dec = await ort.InferenceSession.create(decBuf, opts);
        encoder = enc;
        decoder = dec;
        state.status = 'ready';
        state.detail = 'MobileSAM 已就绪（实验）';
        return { enc, dec };
      } catch (error) {
        state.status = isOom(error) ? 'failed' : 'unavailable';
        state.detail = isOom(error)
          ? 'MobileSAM 内存不足，已回退本地多点建议'
          : `MobileSAM 载入失败：${error instanceof Error ? error.message : 'unknown'}`;
        encoder = null;
        decoder = null;
        return null;
      }
    })();
  }
  const sessions = await sessionPromise;
  if (!sessions) sessionPromise = null; // allow retry after unavailable (e.g. models installed later)
  return Boolean(sessions);
}

function buildLetterboxTensor(rgba: Uint8ClampedArray, width: number, height: number, ort: OrtModule): Tensor {
  const scale = TARGET / Math.max(width, height);
  const newW = Math.max(1, Math.round(width * scale));
  const newH = Math.max(1, Math.round(height * scale));
  const padX = 0;
  const padY = 0;
  letterbox = { scale, padX, padY, origW: width, origH: height, modelW: newW, modelH: newH };

  // Nearest-neighbour resize into top-left of 1024 HWC canvas (ImageNet norm).
  const data = new Float32Array(TARGET * TARGET * 3);
  for (let y = 0; y < newH; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale));
      const si = (sy * width + sx) * 4;
      const di = ((padY + y) * TARGET + (padX + x)) * 3;
      data[di] = (rgba[si] / 255 - MEAN[0]) / STD[0];
      data[di + 1] = (rgba[si + 1] / 255 - MEAN[1]) / STD[1];
      data[di + 2] = (rgba[si + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  return new ort.Tensor('float32', data, [TARGET, TARGET, 3]);
}

function mapPointToModel(p: Point): [number, number] {
  return [p.x * letterbox.scale + letterbox.padX, p.y * letterbox.scale + letterbox.padY];
}

export async function encodeMobileSamImage(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  cacheKey: string,
): Promise<boolean> {
  if (!(await ensureMobileSam()) || !encoder) return false;
  if (embedding && embeddingKey === cacheKey) {
    state.embeddingReady = true;
    return true;
  }
  try {
    const ort = await loadOrt();
    state.detail = 'MobileSAM 编码中…';
    const input = buildLetterboxTensor(rgba, width, height, ort);
    const out = await encoder.run({ input_image: input });
    embedding = out.image_embeddings as Tensor;
    embeddingKey = cacheKey;
    state.embeddingReady = true;
    state.status = 'ready';
    state.detail = 'MobileSAM 编码完成';
    return true;
  } catch (error) {
    embedding = null;
    embeddingKey = '';
    state.embeddingReady = false;
    state.status = 'failed';
    state.detail = isOom(error)
      ? 'MobileSAM 编码 OOM，已回退本地多点建议'
      : `MobileSAM 编码失败：${error instanceof Error ? error.message : 'unknown'}`;
    return false;
  }
}

function maskFromLogits(logits: Tensor): MaskBuffer {
  const dims = logits.dims;
  const mh = Number(dims[dims.length - 2]);
  const mw = Number(dims[dims.length - 1]);
  const data = logits.data as Float32Array;
  const { scale, padX, padY, origW, origH, modelW, modelH } = letterbox;
  const mask = createMask(origW, origH, 0);
  for (let y = 0; y < origH; y++) {
    const my = Math.min(modelH - 1, Math.max(0, Math.round(y * scale)));
    for (let x = 0; x < origW; x++) {
      const mx = Math.min(modelW - 1, Math.max(0, Math.round(x * scale)));
      const lx = padX + mx;
      const ly = padY + my;
      if (lx < 0 || ly < 0 || lx >= mw || ly >= mh) continue;
      if (data[ly * mw + lx] > 0) mask[y * origW + x] = 255;
    }
  }
  return mask;
}

export async function predictMobileSam(
  prompts: PromptPoint[],
): Promise<SuggestResult | null> {
  if (!decoder || !embedding) return null;
  const positives = prompts.filter((p) => p.label === 1);
  if (!positives.length) return null;
  try {
    const ort = await loadOrt();
    const coords: number[] = [];
    const labels: number[] = [];
    for (const p of prompts) {
      const [x, y] = mapPointToModel(p);
      coords.push(x, y);
      labels.push(p.label === 1 ? 1 : 0);
    }
    // SAM ONNX exports expect a padding point with label -1 when only one prompt.
    if (labels.length === 1) {
      coords.push(0, 0);
      labels.push(-1);
    }
    const n = labels.length;
    const feeds: Record<string, Tensor> = {
      image_embeddings: embedding,
      point_coords: new ort.Tensor('float32', Float32Array.from(coords), [1, n, 2]),
      point_labels: new ort.Tensor('float32', Float32Array.from(labels), [1, n]),
      mask_input: new ort.Tensor('float32', new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new ort.Tensor('float32', Float32Array.from([0]), [1]),
      orig_im_size: new ort.Tensor('float32', Float32Array.from([TARGET, TARGET]), [2]),
    };
    const out = await decoder.run(feeds);
    const mask = maskFromLogits(out.masks as Tensor);
    const pixels = countMaskPixels(mask);
    if (pixels < 4) return null;
    const polygon = maskToPolygon(mask, letterbox.origW, letterbox.origH);
    if (!polygon || polygon.length < 3) return null;
    state.detail = `MobileSAM · ${pixels.toLocaleString()} px`;
    return {
      shape: { type: 'polygon', points: polygon },
      pixels,
      boundedByEdge: false,
      boundedByColour: false,
      boundedBySize: false,
      boundedByBox: false,
    };
  } catch (error) {
    state.status = 'failed';
    state.detail = isOom(error)
      ? 'MobileSAM 推理 OOM，已回退本地多点建议'
      : `MobileSAM 推理失败：${error instanceof Error ? error.message : 'unknown'}`;
    return null;
  }
}

/** Full path used by the suggest tool: encode if needed, then decode. */
export async function suggestWithMobileSam(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  prompts: PromptPoint[],
  cacheKey: string,
): Promise<SuggestResult | null> {
  if (!(await encodeMobileSamImage(rgba, width, height, cacheKey))) return null;
  return predictMobileSam(prompts);
}

export function resetMobileSamEmbedding(): void {
  embedding = null;
  embeddingKey = '';
  state.embeddingReady = false;
}
