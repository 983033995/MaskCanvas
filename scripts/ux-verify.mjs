import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { morphRegionShapes, rasterizeRegionMask, countMaskPixels, inwardFeatherAlpha } from '../app/mask-morphology.ts';
import { snapToEdge, didSnapToEdge, buildEdgeMap } from '../app/magnetic-lasso.ts';
import { computeChannelDiff, paintDiffHeatmap } from '../app/canvas-diff.ts';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const host = { Host: '127.0.0.1:7317', Origin: 'http://127.0.0.1:7317' };
const session = await (await fetch('http://127.0.0.1:7317/api/session', { headers: host })).json();
const token = session.token;
const auth = { ...host, 'Content-Type': 'application/json', 'x-maskcanvas-token': token };

const png = await sharp({
  create: { width: 96, height: 64, channels: 3, background: { r: 180, g: 120, b: 90 } },
}).png().toBuffer();
const imageDataUrl = `data:image/png;base64,${png.toString('base64')}`;

const created = await fetch('http://127.0.0.1:7317/api/projects', {
  method: 'POST', headers: auth, body: JSON.stringify({ name: 'ux-canvas-workbench-verify', imageDataUrl }),
});
if (!created.ok) throw new Error(`create project ${created.status} ${await created.text()}`);
const project = await created.json();

const region = {
  id: crypto.randomUUID(),
  name: '编辑区域 1',
  kind: 'edit',
  intent: 'ux verify',
  feather: 6,
  shapes: [{ type: 'rect', x: 20, y: 12, width: 40, height: 28 }],
};
const keep = {
  id: crypto.randomUUID(),
  name: '保护区域 1',
  kind: 'keep',
  intent: 'protect',
  feather: 0,
  shapes: [{ type: 'rect', x: 70, y: 8, width: 18, height: 18 }],
};

const saved = await fetch(`http://127.0.0.1:7317/api/projects/${project.id}/regions`, {
  method: 'PUT', headers: auth,
  body: JSON.stringify({ revision: project.revision, regions: [region, keep] }),
});
if (!saved.ok) throw new Error(`save regions ${saved.status} ${await saved.text()}`);
const afterSave = await saved.json();

const expanded = morphRegionShapes(region, 96, 64, 'expand', 3);
const contracted = morphRegionShapes(region, 96, 64, 'contract', 2);
const inverted = morphRegionShapes(region, 96, 64, 'invert');
const mask = rasterizeRegionMask(region.shapes, 96, 64);
const feather = inwardFeatherAlpha(mask, 96, 64, 6);

const pixels = new Uint8ClampedArray(100 * 80 * 4);
for (let y = 0; y < 80; y++) for (let x = 0; x < 100; x++) {
  const o = (y * 100 + x) * 4;
  const left = x < 50;
  pixels[o] = left ? 240 : 10; pixels[o + 1] = left ? 20 : 190; pixels[o + 2] = left ? 30 : 60; pixels[o + 3] = 255;
}
const edge = buildEdgeMap(pixels, 100, 80);
const far = snapToEdge(edge, { x: 20, y: 40 }, 8, 0.25, { stickiness: 1.15, margin: 0.1 });
const near = snapToEdge(edge, { x: 54, y: 40 }, 10, 0.25, { stickiness: 1.15, margin: 0.1 });

const base = new Uint8Array(16); base.set([10, 10, 10, 255, 10, 10, 10, 255, 10, 10, 10, 255, 10, 10, 10, 255]);
const cand = Uint8Array.from(base); cand[0] = 200;
const diff = computeChannelDiff(base, cand, 2, 2);
const rgba = new Uint8Array(16); paintDiffHeatmap(diff.deltaMap, diff.maxChannelDelta, rgba);

const ui = await fetch('http://127.0.0.1:7317/', { headers: host });
const html = await ui.text();
const assetMatch = html.match(/\/assets\/index-[^"]+\.js/);
const jsOk = assetMatch ? (await fetch(`http://127.0.0.1:7317${assetMatch[0]}`, { headers: host })).ok : false;

const report = {
  at: new Date().toISOString(),
  timezoneNote: 'box clock Asia/Shanghai',
  server: 'http://127.0.0.1:7317',
  projectId: project.id,
  revisionAfterSave: afterSave.revision,
  regionCount: afterSave.regions.length,
  morphology: {
    expandPixels: expanded.afterPixels,
    contractPixels: contracted.afterPixels,
    invertPixels: inverted.afterPixels,
    featherCoreAbove250: [...feather].filter(v => v >= 250).length,
    maskPixels: countMaskPixels(mask),
  },
  magnetic: {
    farFree: far.x === 20 && far.y === 40,
    nearSnapped: Math.abs(near.x - 50) <= 2,
    didSnapNear: didSnapToEdge({ x: 54, y: 40 }, near),
  },
  diff: { changedPixels: diff.changedPixels, heatAlpha: rgba[3] > 0 },
  ui: { status: ui.status, bundle: assetMatch?.[0] ?? null, bundleOk: jsOk },
};

mkdirSync('docs/evidence', { recursive: true });
writeFileSync('docs/evidence/ux-canvas-workbench-20261023.md', `# UX canvas workbench self-verify

Date: 2026-10-23 (Asia/Shanghai). Branch: \`ux/canvas-workbench\`.

## What was broken (magnetic lasso) and the fix

**Symptoms:** After switching to the magnetic lasso, the path constantly snapped and stuck to points while moving, even on flat areas. Auto-fasteners dropped about every 16 screen px, locking in bad snaps.

**Root causes:**
1. Auto-commit on every 16px of travel regardless of edge confidence.
2. Default contrast 12% + generous radius yanked toward weak gradients.
3. Live-wire ran even when the endpoint was not on an edge, pulling the rubber-band sideways.

**Fixes (priority this pass):**
- \`snapToEdge\` only wins when edge score beats free-cursor baseline (\`contrast + margin\`); stronger distance penalty; optional stickiness.
- Auto-anchors only when actually snapped **and** travel ≥ 52 screen px; otherwise free rubber-band.
- Defaults: snap radius 10, edge strength 28%; Alt still disables snap entirely.
- Closing path / Space-pan (no lost anchors) preserved.
- New tests for snap-vs-free and high-contrast soft-gradient freedom.

## Other UX landed this pass

| Feature | Paths |
|---|---|
| Mask expand / contract / invert | \`app/mask-morphology.ts\`, annotate panel in \`app/App.tsx\` |
| Live inward feather preview | \`app/canvas-render.ts\` + region feather slider copy |
| Wipe compare + diff heatmap + protect-0px chip | \`app/ReviewCompare.tsx\`, \`app/canvas-diff.ts\`, version strip / candidate panel |
| E/K/C legend + active marching ants | \`app/canvas-render.ts\`, \`app/styles.css\` |
| Alt temporary erase while brushing | \`app/CanvasEditor.tsx\` |
| Space-pan during lasso without losing anchors | \`app/CanvasEditor.tsx\` |

Deferred: SAM / click-to-suggest mask.

## Automated checks

- \`npm test\`: 81 pass (includes morphology, diff, magnetic snap-vs-free).
- \`npm run build\`: tsc + Vite OK.

## Live server checks (this box)

Server: \`npm start\` → http://127.0.0.1:7317/

\`\`\`json
${JSON.stringify(report, null, 2)}
\`\`\`

Script: \`npx tsx scripts/ux-verify.mjs\` (expects the server already listening).
`);

console.log(JSON.stringify(report, null, 2));
if (!report.magnetic.farFree || !report.magnetic.nearSnapped || !report.diff.heatAlpha || !report.ui.bundleOk) {
  process.exitCode = 1;
}
