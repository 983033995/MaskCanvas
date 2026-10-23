#!/usr/bin/env node
/**
 * Download pinned MobileSAM ONNX weights and copy onnxruntime-web WASM
 * into app/public for the experimental browser path.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const modelDir = path.join(root, 'app/public/models/mobilesam');
const ortDir = path.join(root, 'app/public/ort');
const files = [
  {
    name: 'mobile_sam_image_encoder.onnx',
    url: 'https://huggingface.co/comicbox/mobilesam-onnx/resolve/main/mobile_sam_image_encoder.onnx',
    sha256: '580f5fb648ea1062c0aabc26217aed56921985f03f0cbbd852bba81d760cc749',
  },
  {
    name: 'sam_mask_decoder_single.onnx',
    url: 'https://huggingface.co/comicbox/mobilesam-onnx/resolve/main/sam_mask_decoder_single.onnx',
    sha256: '93915fc7c993ab9d59ab8c9ccd3bce37f7509c81ab4150a74abd4d2abbd8570d',
  },
];

async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`download failed ${response.status} ${url}`);
  await pipeline(response.body, createWriteStream(dest));
}

await mkdir(modelDir, { recursive: true });
for (const file of files) {
  const dest = path.join(modelDir, file.name);
  try {
    await access(dest);
    const digest = await sha256File(dest);
    if (digest === file.sha256) { console.log('ok', file.name); continue; }
    console.log('hash mismatch, re-fetch', file.name);
  } catch { /* missing */ }
  console.log('fetch', file.name);
  await download(file.url, dest);
  const digest = await sha256File(dest);
  if (digest !== file.sha256) throw new Error(`sha256 mismatch for ${file.name}: ${digest}`);
  console.log('saved', file.name, digest.slice(0, 12));
}

await mkdir(ortDir, { recursive: true });
const ortSrc = path.join(root, 'node_modules/onnxruntime-web/dist');
for (const name of [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
]) {
  await copyFile(path.join(ortSrc, name), path.join(ortDir, name));
  console.log('copied', name);
}
console.log('MobileSAM assets ready under app/public/');
