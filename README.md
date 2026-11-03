# MaskCanvas

**使用者与 AI Agent 共用的照片精修工作台。**

人工精准标注、人机协同、Agent 自主执行，使用同一份照片、蒙版、版本和验收结果。连接个人 Windows ComfyUI 的 Qwen Image，以及项目明确允许的 GPT Image 2.5 编辑服务。

> 状态：0.1 本地核心迭代已实现并进行验收。人工标注、保护合成、候选/版本、编辑包和通用 MCP 已跑通；真实 Qwen 出图、GPT 与自动识别仍待后续验收。v2 图稿是视觉基线。

## 运行

```bash
rtk npm ci
rtk npm run build
rtk npm start
```

打开 `http://127.0.0.1:7317`。页面可导入 JPEG/PNG 或“体验合成示例”。完整运行、Qwen 与 MCP 说明见 [运行文档](docs/running.md)。开发模式为 `rtk npm run dev`。

当前可以画矩形/笔画/多边形选区和保护区、保存恢复、导入外部候选并本地合成验收、接受新版本、导出 PNG，复制/导出/导入标注 JSON，再通过 MCP 或界面接手。图像默认不返回给外部 Agent。未配置的 GPT 和视觉能力不会被展示为可用。

[迭代进度与证据](docs/development-progress.md) · [视觉验收](design-qa.md)

## 本轮交付

- [完整需求](docs/requirements.md)：三模式、双后端、像素边界、数据交接与验收。
- [产品简报](docs/product-brief.md)：定位与范围。
- [实施计划](docs/implementation-plan.md)：阶段、依赖、退出条件与风险。
- [架构方案](docs/architecture.md)：编辑核心、MCP、作业与适配器。
- [交互规范](docs/interaction-roadmap.md)：主流程、状态、异常与接管。
- [UI 规范](docs/ui-spec.md)：新版信息架构、屏幕与视觉系统。
- [新版效果图与交互图](design/v2/README.md)：8 个产品界面与 2 张交互图，直接生成 PNG。

设计阶段交付为直接生成的 PNG；开发阶段的应用入口位于 `app/`。仓库原有 `design/ui-mockup.html` 与 `design/generated/` 仅保留为历史资产，不代表新版设计或可用功能。

## 工作方式

| 人工标注 | 协同精修 | 自主精修 |
|---|---|---|
| 人画区域与保护 mask，生成或导出编辑包 | Agent 提出区域和计划，人修正并验收 | Agent 根据目标建区、执行、检查，在任务预算内完成 |

不同 Agent 通过通用 MCP 调用同一个编辑核心。JSON 使用资产引用与哈希，不绑定某个聊天客户端。同机共享工作区可直接交接，跨设备必须先取得并绑定图片。

## 精度与隐私

模型只产生候选。最终合成器限制修改范围、恢复保护区，并对无损基准报告像素差分。自然度、身份和接缝仍需原尺寸检查；JPEG 重编码与整图超分不能承诺零差分。

本地处理可包含个人设备间传输；远端生成和远端图像分析分别允许。ComfyUI API 节点在本机不等于模型推理在本机。

## 下一步

当前优先 [Agent 发起的确认流程](docs/agent-workflow.md)：Agent 给出区域建议 → 编辑器供用户调整 → 确认计划 → 执行。常规交接只用 JSON，ZIP 不是主路径。


后续优先级为真实 Qwen 局部编辑验收、GPT 路线、本地观察/分割和三客户端逐一接入；范围与阻塞见迭代进度。2026-10-21 的研究见 [研究记录](docs/solution-research-2026-10-21.md)，其中运行状态仅为当时的只读快照。

## License

[MIT](LICENSE)。复用第三方 GPL/AGPL 软件时单独核对许可证义务。
