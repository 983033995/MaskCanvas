# UX canvas workbench self-verify

Date: 2026-10-23 (Asia/Shanghai). Branch: `ux/canvas-workbench`.

## What was broken (magnetic lasso) and the fix

**Symptoms:** After switching to the magnetic lasso, the path constantly snapped and stuck to points while moving, even on flat areas. Auto-fasteners dropped about every 16 screen px, locking in bad snaps.

**Root causes:**
1. Auto-commit on every 16px of travel regardless of edge confidence.
2. Default contrast 12% + generous radius yanked toward weak gradients.
3. Live-wire ran even when the endpoint was not on an edge, pulling the rubber-band sideways.

**Fixes (priority this pass):**
- `snapToEdge` only wins when edge score beats free-cursor baseline (`contrast + margin`); stronger distance penalty; optional stickiness.
- Auto-anchors only when actually snapped **and** travel ≥ 52 screen px; otherwise free rubber-band.
- Defaults: snap radius 10, edge strength 28%; Alt still disables snap entirely.
- Closing path / Space-pan (no lost anchors) preserved.
- New tests for snap-vs-free and high-contrast soft-gradient freedom.

## Other UX landed this pass

| Feature | Paths |
|---|---|
| Mask expand / contract / invert | `app/mask-morphology.ts`, annotate panel in `app/App.tsx` |
| Live inward feather preview | `app/canvas-render.ts` + region feather slider copy |
| Wipe compare + diff heatmap + protect-0px chip | `app/ReviewCompare.tsx`, `app/canvas-diff.ts`, version strip / candidate panel |
| E/K/C legend + active marching ants | `app/canvas-render.ts`, `app/styles.css` |
| Alt temporary erase while brushing | `app/CanvasEditor.tsx` |
| Space-pan during lasso without losing anchors | `app/CanvasEditor.tsx` |

Deferred: SAM / click-to-suggest mask.

## Automated checks

- `npm test`: 81 pass (includes morphology, diff, magnetic snap-vs-free).
- `npm run build`: tsc + Vite OK.

## Live server checks (this box)

Server: `npm start` → http://127.0.0.1:7317/

```json
{
  "at": "2026-10-23T03:16:20.373Z",
  "timezoneNote": "box clock Asia/Shanghai",
  "server": "http://127.0.0.1:7317",
  "projectId": "1164d640-a257-4223-b76d-fd35fa6b69c7",
  "revisionAfterSave": 1,
  "regionCount": 2,
  "morphology": {
    "expandPixels": 1564,
    "contractPixels": 864,
    "invertPixels": 5024,
    "featherCoreAbove250": 448,
    "maskPixels": 1120
  },
  "magnetic": {
    "farFree": true,
    "nearSnapped": true,
    "didSnapNear": true
  },
  "diff": {
    "changedPixels": 1,
    "heatAlpha": true
  },
  "ui": {
    "status": 200,
    "bundle": "/assets/index-J1mJZkph.js",
    "bundleOk": true
  }
}
```

Script: `npx tsx scripts/ux-verify.mjs` (expects the server already listening).


## Continue pass (same day) — suggest + snap strength + annotate quick wins

### Landed
1. **吸附强度 slider** on magnetic lasso (0–100). Maps to `stickiness` / `margin` in `snapToEdge` (`app/CanvasEditor.tsx`, `app/magnetic-lasso.ts`). Low = freer cursor; high = stickier edge pull. Alt still disables snap.
2. **点选建议 (G)** — lightweight local edge+colour flood-fill suggest → polygon refine flow. **Not SAM** (no ONNX/WASM deps). Module `app/region-suggest.ts`; tool on rail; refine with brush / expand-contract.
3. **Annotate quick wins:** `M` toggle masks; canvas `0`/`1`/`+`/`-` zoom when focused; edit-region overlap hint in inspector.

### Checks
- `npm test` 84/84
- `npm run build` OK
- Server restarted with `MASKCANVAS_BIND=0.0.0.0` + `MASKCANVAS_ALLOW_REMOTE_BROWSER=1`; listens `0.0.0.0:7317`
- Curl with `Host/Origin: http://100.82.229.104:7317` → UI 200, capabilities 200, new bundle 200

Deferred still: full SAM2 model pack; agent autonomous segment.
