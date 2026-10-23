import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGptWorkflow, checkGptCapability, type GptProviderModel } from './gpt.js';

// Enum values below are copied from the verified CLIProxyAPIGPTImage2
// object_info response; metadata is kept minimal because capability detection
// depends on the reported choices and input names.
const verifiedObjectInfo = {
  CLIProxyAPIGPTImage2: {
    input: {
      required: {
        provider_model: [[
          'gpt-image-2.5-flare (OpenAI Commercial)',
          'gpt-image-2.5-sunburst (OpenAI Commercial)',
          'gpt-image-2.5 (OpenAI Commercial)',
          'gemini-3.1-flash-image (Nano Banana 2)',
          'grok-imagine-image-quality (xAI Grok)',
          'minimax-image-01 (MiniMax Oriental)',
        ]],
        prompt: ['STRING', { multiline: true }],
        mode: [['generate', 'edit']],
        aspect_ratio: [['auto', '1:1', '16:9', '9:16', '3:4', '4:3', '3:2', '2:3']],
        size_hint: [['auto', '1K', '2K', '4K']],
        seed: ['INT', { min: 0, max: 9007199254740991 }],
      },
      optional: {
        image: ['IMAGE', {}],
      },
    },
  },
};

const gptModelCases: Array<[GptProviderModel, string]> = [
  ['gpt-image-2.5-flare', 'gpt-image-2.5-flare (OpenAI Commercial)'],
  ['gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst (OpenAI Commercial)'],
  ['gpt-image-2.5', 'gpt-image-2.5 (OpenAI Commercial)'],
];

function cloneObjectInfo() {
  return structuredClone(verifiedObjectInfo);
}

test('GPT edit workflow maps API model IDs to the verified Comfy display labels', () => {
  for (const [providerModel, displayLabel] of gptModelCases) {
    const workflow = buildGptWorkflow('maskcanvas/input.png', 'remove stray hair', 123, 'maskcanvas/test', { providerModel });
    assert.equal(workflow['6'].inputs.provider_model, displayLabel);
    assert.equal(checkGptCapability(verifiedObjectInfo, true, providerModel).available, true);
  }

  const workflow = buildGptWorkflow('maskcanvas/input.png', 'remove stray hair', 123, 'maskcanvas/test');
  assert.deepEqual(Object.keys(workflow), ['5', '6', '13']);
  assert.deepEqual(workflow['5'], { class_type: 'LoadImage', inputs: { image: 'maskcanvas/input.png' } });
  assert.equal(workflow['6'].class_type, 'CLIProxyAPIGPTImage2');
  assert.equal(workflow['6'].inputs.mode, 'edit');
  assert.equal(workflow['6'].inputs.aspect_ratio, '1:1');
  assert.equal(workflow['6'].inputs.size_hint, '1K');
  assert.equal(workflow['6'].inputs.seed, 123);
  assert.deepEqual(workflow['6'].inputs.image, ['5', 0]);
  assert.deepEqual(workflow['13'], {
    class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: 'maskcanvas/test' },
  });

  const selected = buildGptWorkflow('input.png', 'edit this', 7, 'out', {
    providerModel: 'gpt-image-2.5-sunburst', aspectRatio: '16:9', sizeHint: '2K',
  });
  assert.deepEqual(selected['6'].inputs, {
    provider_model: 'gpt-image-2.5-sunburst (OpenAI Commercial)',
    prompt: 'edit this', mode: 'edit', aspect_ratio: '16:9', size_hint: '2K', seed: 7, image: ['5', 0],
  });
});

test('GPT workflow rejects unsupported provider models instead of falling back', () => {
  assert.throws(
    () => buildGptWorkflow('input.png', 'edit this', 7, 'out', { providerModel: 'sunburst' as GptProviderModel }),
    /不支持的 GPT Image provider_model/,
  );
  assert.throws(
    () => buildGptWorkflow('input.png', 'edit this', 7, 'out', { providerModel: 'gpt-image-2' as GptProviderModel }),
    /不支持的 GPT Image provider_model/,
  );
  assert.throws(() => buildGptWorkflow('input.png', 'edit this', -1, 'out'), /seed 必须是非负安全整数/);
  assert.throws(() => buildGptWorkflow('input.png', 'edit this', 1.5, 'out'), /seed 必须是非负安全整数/);
  assert.throws(() => buildGptWorkflow('input.png', 'edit this', 1, 'out', { aspectRatio: '21:9' as never }), /不支持的 GPT Image aspect_ratio/);
});

test('GPT capability stays unavailable when remote execution is disabled', () => {
  const result = checkGptCapability(verifiedObjectInfo, false);
  assert.equal(result.available, false);
  assert.match(result.reason, /远端执行已禁用/);
});

test('GPT capability validates the selected model, edit mode, aspect ratio, and size hint', () => {
  const available = checkGptCapability(verifiedObjectInfo, true);
  assert.equal(available.available, true);
  assert.match(available.reason, /gpt-image-2.5-flare \(OpenAI Commercial\)/);
  assert.match(available.reason, /seed 不保证生成结果确定/);
  assert.equal(checkGptCapability(verifiedObjectInfo, true, 'gpt-image-2.5', '2:3', '4K').available, true);

  const node = cloneObjectInfo().CLIProxyAPIGPTImage2;
  node.input.required.provider_model[0] = ['gpt-image-2.5-sunburst (OpenAI Commercial)'];
  assert.match(checkGptCapability({ CLIProxyAPIGPTImage2: node }, true).reason, /未提供所选模型：gpt-image-2.5-flare/);
  assert.equal(checkGptCapability({ CLIProxyAPIGPTImage2: node }, true, 'gpt-image-2.5-sunburst').available, true);

  assert.equal(checkGptCapability({}, true).available, false);
  const missingPrompt = cloneObjectInfo();
  delete (missingPrompt.CLIProxyAPIGPTImage2.input.required as Record<string, unknown>).prompt;
  assert.match(checkGptCapability(missingPrompt, true).reason, /缺少必需参数：prompt/);
  const noEdit = cloneObjectInfo();
  noEdit.CLIProxyAPIGPTImage2.input.required.mode[0] = ['generate'];
  assert.match(checkGptCapability(noEdit, true).reason, /未提供 edit 模式/);
  assert.match(checkGptCapability(verifiedObjectInfo, true, 'gpt-image-2.5-flare', '21:9' as never).reason, /未提供所选 aspect_ratio=21:9/);
  assert.match(checkGptCapability(verifiedObjectInfo, true, 'gpt-image-2.5-flare', '1:1', '8K' as never).reason, /未提供所选 size_hint=8K/);
  const noImage = cloneObjectInfo();
  delete (noImage.CLIProxyAPIGPTImage2.input.optional as Record<string, unknown>).image;
  assert.match(checkGptCapability(noImage, true).reason, /缺少参考图片输入 image/);
});
