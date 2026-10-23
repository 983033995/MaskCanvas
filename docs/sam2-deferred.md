# SAM2 / MobileSAM 说明

日期：2026-10-23。分支：`ux/canvas-workbench`。

## 本轮结论

已接入**实验性**浏览器 MobileSAM（`onnxruntime-web` + 本地 ONNX），默认关闭：

- 建议工具勾选 **「SAM（实验）」** 后懒加载 `/models/mobilesam/*.onnx` 与 `/ort/` WASM。
- 编码一次 / 每次提示点解码；OOM、缺权重、推理失败时**自动回退**本地多点边缘+色彩启发式。
- 权重 **不进 git**（约 45 MB）；用 `node scripts/fetch-mobilesam.mjs` 拉取 comicbox 镜像（encoder/decoder sha256 已钉扎）。

完整 **SAM2** 仍未接入（体积与验收成本更大）。

## 仍保留启发式的原因

1. 默认路径必须零下载、可离线；SAM 仅实验开关。
2. 盒内可用内存常约 3 GB 级，WASM 编码可能 OOM —— 回退路径是产品要求而非权宜。
3. 前端交互验收仍依赖用户浏览器；本轮以单元/API 测试 + 本地 ORT 冒烟验证张量通路。

## Agent 选区

服务端 `POST /api/projects/:id/propose-regions` 与 MCP `canvas_propose_regions` 用**同一套启发式**从基准图提出多边形，并写入 **draft** 提议（`autoConfirmed: false`）。**不会**替用户确认或开生成。

## 参考

- https://huggingface.co/comicbox/mobilesam-onnx  
- https://github.com/ChaoningZhang/MobileSAM  
