# MaskCanvas — Architecture

## Goals

- Local-first: image, masks, versions, and model calls stay on the machine.
- Human-in-the-loop: the canvas is the source of truth for geometry; the agent is the executor.
- Model-agnostic: Qwen-Image 2.1 first, other local ComfyUI models later.
- Small surface: a web canvas + a local MCP server + a ComfyUI adapter.

## Components

```text
┌──────────────────────────────┐
│ Browser (127.0.0.1)          │
│ React + Vite + Konva         │
│ canvas / masks / regions     │
└──────────────┬───────────────┘
               │ HTTP + WS (session token)
┌──────────────▼───────────────┐
│ MaskCanvas local server      │
│ - static UI                  │
│ - project store (files)      │
│ - job queue / state          │
│ - MCP server (stdio/HTTP)    │
└──────────────┬───────────────┘
               │ HTTP
┌──────────────▼───────────────┐
│ ComfyUI (local/tailnet)      │
│ Qwen-Image-2.1 Turbo         │
│ Inpaint Crop/Stitch          │
└──────────────────────────────┘
```

Suggested stack:

| Layer | Choice | Why |
|---|---|---|
| UI | React + Vite + TypeScript | Fast, typed, easy local dev |
| Canvas | Konva (react-konva) | Selection handles, masks, layers, zoom/pan |
| State | Zustand | Small, predictable; undo/redo via command stack |
| Styling | Tailwind + CSS variables | Design tokens map cleanly |
| Server | TypeScript + Fastify/Express | Same language as UI; easy static hosting |
| MCP | `@modelcontextprotocol/sdk` | stdio for local agents; optional HTTP |
| Realtime | WebSocket/SSE | Job progress to UI |
| Store | Filesystem + SQLite (optional) | Simple; project portability |
| Qwen | ComfyUI HTTP API | Reuses the existing node; no new model stack |

## Project store

```text
~/Pictures/MaskCanvas/<project_id>/
  source.png
  preview.png
  regions.json
  masks/
    r1.png
    r2.png
    k1.png
  versions/
    v1.png
    v1.json
    v2.png
    v2.json
  exports/
```

`regions.json`:

```json
{
  "project_id": "family-portrait",
  "source": "source.png",
  "width": 3376,
  "height": 6000,
  "regions": [
    {"id":"r1","name":"下颌 / 颈线","tool":"lasso","mask":"masks/r1.png","operation":"retouch","prompt":"...","strength":0.8,"feather":18,"protect":false},
    {"id":"r2","name":"上装 / 下装","tool":"brush","mask":"masks/r2.png","operation":"replace","prompt":"...","strength":1.0,"feather":12,"protect":false},
    {"id":"k1","name":"宝宝脸部","tool":"box","mask":"masks/k1.png","operation":"keep","prompt":"","strength":1.0,"feather":8,"protect":true}
  ],
  "versions": [
    {"id":"v1","source":"source.png","accepted":true,"meta":{"model":"qwen-image-2.1","seed":9501,"resolution":1280}},
    {"id":"v2","source":"versions/v2.png","accepted":false,"meta":{"model":"qwen-image-2.1","seed":9512,"resolution":1280}}
  ]
}
```

Rules:

- Masks are full-resolution 8-bit PNGs, white = edit/keep, black = outside.
- `protect: true` masks are subtracted from the edit union; they are not prompts.
- Region order = z-order; overlapping edits merge, keep wins.
- Each version stores its exact inputs (region snapshot + prompt + seed + model +
  resolution) so it is reproducible.
- Source and accepted versions are immutable; deletion only hides a version.

## MCP tool surface

| Tool | Input | Output |
|---|---|---|
| `canvas_open` | `image_path`, `project_id?` | `{project_id, url}` |
| `canvas_add_region` | `project_id`, `mask_path`, `operation`, `prompt`, `protect` | `region` |
| `canvas_get_annotations` | `project_id`, `include_masks?` | `regions.json` + absolute mask paths |
| `canvas_export_mask` | `project_id`, `region_ids?` | `mask.png` (edit union minus keep) |
| `qwen_apply` | `project_id`, `region_ids`, `resolution`, `seed?` | `{job_id}` |
| `qwen_wait` | `job_id`, `timeout?` | `{status, version_id, result_path}` |
| `qwen_cancel` | `job_id` | `{cancelled}` |
| `canvas_list_versions` | `project_id` | versions |
| `canvas_accept` | `project_id`, `version_id` | accepted version |
| `canvas_export` | `project_id`, `format`, `include_annotations` | export path |
| `canvas_close` | `project_id` | `{closed}` |

MCP transport:

- stdio for a local agent launched by the user;
- optional HTTP at `127.0.0.1:7317/mcp` with a per-session token;
- never bind `0.0.0.0` by default.

## Qwen adapter

### Small edit (region inpaint)

1. Build the edit union from non-protect regions; subtract keep masks.
2. Expand the bounding box by 64–128px (context).
3. Upload the full image + expanded crop + mask to ComfyUI.
4. `Inpaint Crop` → Qwen-Image-2.1 Turbo → `Inpaint Stitch`.
5. Feather 16–32px at the stitch; color-match to the base.
6. Return a new version.

If `Inpaint Crop/Stitch` is not installed, fall back to latent-mask canary or
crop-and-composite; mark the version `quality: canary`.

### Large restyle (outfit/hair)

1. Use the region bbox as a crop, with 5–10% margin.
2. Run Qwen instruction edit on the crop.
3. Composite only inside the region mask; subtract keep masks.
4. Use the compositing rules from the Qwen image edit skill:
   - one coherent source region over internal patches;
   - cover old faces fully, no 50/50 face blends;
   - targeted remnant replacement for old clothing;
   - separate warm/cool outfit correction;
   - QA at 100%.

### Multi-region

- Sequential by default; one region = one Qwen call.
- A job can contain several regions; the server runs them in order and creates
  one version per region or one combined version (configurable).
- Never combine face + outfit + background in one call.

## Job queue

- One local queue shared by UI and agent.
- States: `queued`, `running`, `succeeded`, `failed`, `cancelled`.
- If the ComfyUI node is shared with H3, read `/queue` and show the queue
  position; never call `/interrupt` on a non-MaskCanvas job.
- Cancel only the job's own prompt; if the job is still queued, remove it from
  the ComfyUI queue via `POST /queue {"delete":[pid]}`.
- Persist job state in `jobs.json`; resume after server restart by polling
  `/history/{pid}`.

## Security / privacy

- Bind UI and MCP to `127.0.0.1`; random session token in the URL/header.
- No telemetry, no external fonts/CDNs, no cloud calls.
- Project files under `~/Pictures/MaskCanvas/`; `projects/` in the repo ignored.
- Do not log image bytes or prompts to external services.
- Export strips sensitive EXIF by default (optional keep).
- For Feishu delivery, copy final files to the bridge outbox; never send local
  paths.

## Repo layout (target)

```text
MaskCanvas/
  app/                 # React/Vite UI
    src/
      canvas/          # Konva canvas, tools, masks
      inspector/       # region cards, job card, history
      filmstrip/       # versions
      state/           # Zustand store, undo/redo
  server/              # Fastify + MCP + job queue
    src/
      mcp/             # tool definitions
      comfy/           # Qwen adapter
      store/           # project files, SQLite optional
  packages/shared/     # types, JSON schema, mask utils
  docs/
  design/
```

## Testing

- Unit: mask union/subtract, bbox expansion, color match, region state machine.
- Integration: upload → prompt → history → view with a mocked ComfyUI.
- E2E: draw a box → prompt → fake job → version → export.
- Live canary: one real Qwen run on a synthetic portrait (not a private photo).
- Privacy test: assert no outbound network except 127.0.0.1/tailnet.

## Risks

| Risk | Mitigation |
|---|---|
| Qwen changes identity/hands | Crop tightly; keep masks; one region per pass |
| Seams at inpaint stitch | `Inpaint Crop/Stitch` + feather + color match; QA 100% |
| GPU busy with H3 | Queue UX; no interrupt; estimate honestly |
| Large images slow | Downsample preview; full-res mask; process at 1280–1536 |
| Browser canvas performance | Konva layers; mask as a single bitmap; avoid per-pixel React state |
| MCP/UI concurrency | Versioned regions; lock during generation; last-write-wins with audit |
| Private photo leak | Localhost-only, no telemetry, no cloud, explicit export |
