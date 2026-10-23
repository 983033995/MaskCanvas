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
