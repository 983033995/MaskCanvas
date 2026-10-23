# SAM2 / MobileSAM 延后说明

日期：2026-10-23。分支：`ux/canvas-workbench`。

## 结论

本轮**未**接入真实 SAM2 或 MobileSAM ONNX。建议工具改为**多点正/负提示**的本地边缘+色彩分割（SAM 式交互，无神经网络权重）。

## 为何本轮不装

1. **运行环境**：云盒当时可用内存约 3.4 GB（已用约 12 GB）。在同一机器上并行 Vite/测试/服务时，再拉取 onnxruntime-web WASM + 编码器编译，稳定性与开发反馈循环差。
2. **体积与首载**：可用的浏览器 MobileSAM 约 45 MB（encoder≈28 MB + decoder≈16 MB）；SAM2 tiny 更大。精修工作台默认路径不应强制首次下载该体积；需要完整的进度、OPFS 缓存与 Worker，超出本轮可验证范围。
3. **验收约束**：项目前端交互验收依赖用户指定浏览器，不能用 Playwright 冒充；本轮无法在盒内完成真实照片点击分割的视觉验收。
4. **许可与集成**：MobileSAM Apache-2.0 / 部分 ONNX 导出 MIT 可用，但要正确处理输入归一化、多 mask 头选择与坐标映射，仓促接入容易交付“能跑但选不准则”的假 SAM。

## 下一步（若要接）

推荐路径：`onnxruntime-web` + Hugging Face `comicbox/mobilesam-onnx` encoder + Acly `sam_mask_decoder_multi.onnx`，Worker 内 encode-once / decode-per-click，模型放 `public/models/mobilesam/`，建议工具增加“SAM（实验）”开关，默认仍走本地多点。

参考：https://huggingface.co/DotoPototo/paint-models 、https://github.com/karlorz/sam-web
