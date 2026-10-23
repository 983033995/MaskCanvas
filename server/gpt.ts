export type GptProviderModel = 'gpt-image-2.5-flare' | 'gpt-image-2.5-sunburst' | 'gpt-image-2.5';
export type GptAspectRatio = 'auto' | '1:1' | '16:9' | '9:16' | '3:4' | '4:3' | '3:2' | '2:3';
export type GptSizeHint = 'auto' | '1K' | '2K' | '4K';

export type GptWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export interface GptWorkflowOptions {
  providerModel?: GptProviderModel;
  aspectRatio?: GptAspectRatio;
  sizeHint?: GptSizeHint;
}

export interface GptCapability {
  available: boolean;
  reason: string;
}

const GPT_NODE = 'CLIProxyAPIGPTImage2';
const DEFAULT_PROVIDER_MODEL: GptProviderModel = 'gpt-image-2.5-flare';
const DEFAULT_ASPECT_RATIO: GptAspectRatio = '1:1';
const DEFAULT_SIZE_HINT: GptSizeHint = '1K';
const GPT_PROVIDER_MODEL_LABELS: Readonly<Record<GptProviderModel, string>> = {
  'gpt-image-2.5-flare': 'gpt-image-2.5-flare (OpenAI Commercial)',
  'gpt-image-2.5-sunburst': 'gpt-image-2.5-sunburst (OpenAI Commercial)',
  'gpt-image-2.5': 'gpt-image-2.5 (OpenAI Commercial)',
};
const GPT_MODELS = Object.keys(GPT_PROVIDER_MODEL_LABELS) as GptProviderModel[];
const ASPECT_RATIOS: readonly GptAspectRatio[] = ['auto', '1:1', '16:9', '9:16', '3:4', '4:3', '3:2', '2:3'];
const SIZE_HINTS: readonly GptSizeHint[] = ['auto', '1K', '2K', '4K'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function enumValues(inputDefinition: unknown): string[] | null {
  if (!Array.isArray(inputDefinition) || !Array.isArray(inputDefinition[0])) return null;
  return inputDefinition[0].filter((value): value is string => typeof value === 'string');
}

function hasInput(inputs: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(inputs, name);
}

/**
 * Build the known ComfyUI CLIProxy API GPT Image edit graph. The provider model
 * is selected explicitly from the supported set; this adapter never substitutes
 * a different model when a requested choice is unavailable.
 */
export function buildGptWorkflow(
  image: string,
  intent: string,
  seed: number,
  prefix: string,
  options: GptWorkflowOptions = {},
): GptWorkflow {
  if (!image.trim()) throw new Error('GPT Image 参考图片不能为空');
  if (!intent.trim()) throw new Error('GPT Image 编辑提示不能为空');
  if (!prefix.trim()) throw new Error('GPT Image 输出前缀不能为空');
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('GPT Image seed 必须是非负安全整数');

  const providerModel = options.providerModel ?? DEFAULT_PROVIDER_MODEL;
  const aspectRatio = options.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  const sizeHint = options.sizeHint ?? DEFAULT_SIZE_HINT;
  if (!GPT_MODELS.includes(providerModel)) throw new Error(`不支持的 GPT Image provider_model：${String(providerModel)}`);
  if (!ASPECT_RATIOS.includes(aspectRatio)) throw new Error(`不支持的 GPT Image aspect_ratio：${String(aspectRatio)}`);
  if (!SIZE_HINTS.includes(sizeHint)) throw new Error(`不支持的 GPT Image size_hint：${String(sizeHint)}`);

  const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs });
  const modelLabel = GPT_PROVIDER_MODEL_LABELS[providerModel];
  return {
    '5': node('LoadImage', { image }),
    '6': node(GPT_NODE, {
      provider_model: modelLabel,
      prompt: intent,
      mode: 'edit',
      aspect_ratio: aspectRatio,
      size_hint: sizeHint,
      seed,
      image: ['5', 0],
    }),
    '13': node('SaveImage', { images: ['6', 0], filename_prefix: prefix }),
  };
}

/**
 * Check the locally reported ComfyUI object_info shape without contacting a
 * service. `configured` must reflect the caller's explicit remote enablement.
 */
export function checkGptCapability(
  info: unknown,
  configured: boolean,
  providerModel: GptProviderModel = DEFAULT_PROVIDER_MODEL,
  aspectRatio: GptAspectRatio = DEFAULT_ASPECT_RATIO,
  sizeHint: GptSizeHint = DEFAULT_SIZE_HINT,
): GptCapability {
  if (!configured) {
    return { available: false, reason: 'GPT Image 远端执行已禁用；需要显式启用并配置 CLIProxy API 节点后才能使用。' };
  }
  if (!isRecord(info) || !isRecord(info[GPT_NODE])) {
    return { available: false, reason: `缺少 ${GPT_NODE} 节点，GPT Image 远端能力不可用。` };
  }

  const nodeInfo = info[GPT_NODE];
  const inputRoot = isRecord(nodeInfo.input) ? nodeInfo.input : null;
  if (!inputRoot) return { available: false, reason: `${GPT_NODE} 未报告有效输入参数。` };

  const required = isRecord(inputRoot.required) ? inputRoot.required : {};
  const optional = isRecord(inputRoot.optional) ? inputRoot.optional : {};
  const allInputs = { ...required, ...optional };
  const requiredNames = ['provider_model', 'prompt', 'mode', 'aspect_ratio', 'size_hint', 'seed'];
  const missing = requiredNames.filter(name => !hasInput(allInputs, name));
  if (missing.length) return { available: false, reason: `${GPT_NODE} 缺少必需参数：${missing.join('、')}。` };

  const modelLabel = GPT_PROVIDER_MODEL_LABELS[providerModel];
  if (!modelLabel) return { available: false, reason: `不支持的 GPT Image provider_model ID：${String(providerModel)}。` };
  const modelValues = enumValues(allInputs.provider_model);
  if (!modelValues?.includes(modelLabel)) return { available: false, reason: `${GPT_NODE} 未提供所选模型：${modelLabel}。` };

  const modeValues = enumValues(allInputs.mode);
  if (!modeValues?.includes('edit')) return { available: false, reason: `${GPT_NODE} 未提供 edit 模式。` };
  const aspectValues = enumValues(allInputs.aspect_ratio);
  if (!aspectValues?.includes(aspectRatio)) return { available: false, reason: `${GPT_NODE} 未提供所选 aspect_ratio=${String(aspectRatio)}。` };
  const sizeValues = enumValues(allInputs.size_hint);
  if (!sizeValues?.includes(sizeHint)) return { available: false, reason: `${GPT_NODE} 未提供所选 size_hint=${String(sizeHint)}。` };

  if (!hasInput(optional, 'image') && !hasInput(required, 'image')) {
    return { available: false, reason: `${GPT_NODE} 缺少参考图片输入 image。` };
  }

  return {
    available: true,
    reason: `已检测到 ${GPT_NODE} edit 模式、${modelLabel}、aspect_ratio=${aspectRatio} 与 size_hint=${sizeHint}。参考图会发送至远端；seed 不保证生成结果确定。`,
  };
}
