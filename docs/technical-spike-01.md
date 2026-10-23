# 第一次实现选型记录

日期：2026-10-22。

## InpaintCanvas 边界

本轮重新读取上游 `mcp/README.md`，确认命令路由仅接 localhost，MCP 经 ComfyUI HTTP/WS 把命令转到前端；无人值守模式仍启动 Edge/Chrome，并依赖已加载且连线的工作流。来源：[上游 MCP 文档](https://github.com/DenRakEiw/ComfyUI-InpaintCanvas/blob/master/mcp/README.md)。

没有安装、修改或重启 Windows 节点来实测 InpaintCanvas。不能声称它不支持需求，也不能把 README 视为性能验收。本机 ComfyUI 检查时已有一个任务运行。

本轮采用轻量自有 Canvas2D 交互层与独立像素核心，原因是当前明确需要 Mac 控制端、与浏览器生命周期无关的项目/验收、严格保护和便携交接。没有复制上游 GPL 代码；现成 ComfyUI 模型、节点与工作流契约仍复用。未来保留 InpaintCanvas/Krita 外部适配空间。

## 真实检查与限制

- Windows GET `system_stats`：ComfyUI 0.42.1，RTX 3050 8GB。
- GET `queue`：一个运行任务，未提交新的现场生成，不干扰现有工作。
- Qwen 预检：工作流使用的节点与 UNET/CLIP/VAE 模型枚举存在，未据此承诺出图质量。
- 当前用模拟 ComfyUI 协议完整验证上传、提交、幂等、历史查询、回图和精确合成，记录 `server/qwen.test.ts`。

## 后续进入真实生成前

用非私人素材在设备可用时执行一条局部编辑，检查真实输出尺寸、crop 上下文、原尺寸接缝与身份。GPT 路线需单独确认实际服务、账号、费用和图像处理授权；本轮不访问凭据、不进行付费生成。
