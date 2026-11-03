# 运行与 MCP 接入（0.1）

## 本地运行

要求 Node.js 22.12+ 与 npm；本轮使用 Node 26 / npm 11。首次运行依赖安装与锁文件：

```bash
rtk npm ci
rtk npm test
rtk npm run build
rtk npm start
```

访问 `http://127.0.0.1:7317`。开发模式用 `rtk npm run dev`，页面为 `http://127.0.0.1:5173`，API 为 7317。端口冲突时先检查，不杀已有进程。

控制端项目默认为仓库内被忽略的 `projects/`，也可用 `MASKCANVAS_DATA_DIR` 指定独立本地目录；必须保留项目文件与资产一起备份。不要把该目录提交到 Git。

点击“体验合成示例”会通过真实导入接口创建项目。可画编辑/保护区、写意图、保存；导入同尺寸外部候选图可验证本地合成，不会被标为模型生成。接受通过范围检查的候选前仍应人工检查自然度。导出接受版 PNG 或标注 JSON；也可以查看/复制 JSON，或粘贴/导入 Agent 返回的 JSON。标注 JSON 不含图片字节，当前要求同一工作区、图片哈希、基准与 revision 匹配；导入只载入标注，不执行生成。

## Qwen

服务不会自动读取 `.env`。在启动服务的环境中显式配置 `COMFYUI_IMAGE_SERVER_URL`；`.env.example` 是说明模板，不含密钥。

```bash
rtk proxy env COMFYUI_IMAGE_SERVER_URL=http://100.123.176.90:8188 npm start
```

支持现有 Qwen Image 2.1 Turbo、8B 编码器与 Qwen VAE 路线。当前参考 crop 按 32 像素网格补边，`resolution=0`，严格检查返回尺寸，不拉伸整图。上下文限制约 160 万像素；超过时请拆区域。

作业先在本地持久化；设备忙则等待，不抢占其他任务。生成记录与输入快照存在 `projects/jobs.json`。超时状态核对原 prompt ID，不自动重发；未知状态会保留并说明，不阻塞其他独立任务。首版没有运行中作业取消接口，不提供假取消按钮。

已完成合成照片的真实两步 Qwen 集成，范围验收通过，但除皱纹理质量未通过，候选已拒绝并保留历史。另一个人工添加黑点的去尘样例通过原尺寸复核并接受。单个正例不能代替其他修饰类型验收。

编辑区可选 `context: {x,y,width,height}` 指定原图像素观察范围。编辑器以虚线显示，必须包含有效编辑像素；观察范围不会扩大允许修改的像素。未填写时仍使用自动上下文。

## GPT Image

GPT 已有基于现存 `CLIProxyAPIGPTImage2` 的适配与模拟集成，尚未进行实际付费出图。默认 `MASKCANVAS_ALLOW_REMOTE_GENERATION=0`。启用前需由操作者明确配置中转地址与模型，并核对该 ComfyUI 节点的私有远端路由；工具不会读取或写入其中的凭据。

`MASKCANVAS_GPT_DESTINATION` 必须与 `COMFYUI_IMAGE_SERVER_URL` 的 origin 一致，表示实际接收上传图片的中转节点。最终云服务路由由节点私有配置决定，不宣称仅凭该变量就验证了最终远端地址。`MASKCANVAS_GPT_MODEL` 仅允许 `gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-2.5`，不静默切换。

此外需要用户在项目授权面板为当前基准照片授予 GPT 生成权限，并选择匹配的授权执行已确认计划。界面默认给一个计划作业、1 小时有效期；一个多区域计划可能调用多次远端生成。未启用或未授权时明确拒绝，不回退 Qwen。

当前 GPT 用 1024×1024 上下文补边，不缩放原像素；裁切不能超过该尺寸，返回尺寸不符时保存产物并拒绝拼回。seed 不保证远端结果确定性。生成只成为候选，须另行验收和接受。

## 通用 MCP

先启动本地 HTTP 服务。MCP 进程只是适配层，所有客户端共用该服务；不会各启动一份项目库。

示例配置（未自动写入用户客户端）：

```json
{
  "mcpServers": {
    "maskcanvas": {
      "command": "npm",
      "args": ["--prefix", "/Volumes/13759427003/AI/MaskCanvas", "run", "--silent", "mcp"],
      "env": {
        "MASKCANVAS_URL": "http://127.0.0.1:7317",
        "MASKCANVAS_AGENT_CLIENT": "client:codex"
      }
    }
  }
}
```

Codex 的客户端配置语法与上例不同，应按其 MCP 设置填写相同的 command/args/env；WorkBuddy、Qoder 也分别通过自己的连接入口导入。当前已用 SDK 的真实 stdio 客户端验证协议，尚未把本工具安装进这三个客户端并逐一验收。

工具包括：能力、项目列表/导入/读取、区域保存、受控观察、标注 JSON 获取/回导、独立建议创建/读取/修改/JSON 导入、建议审阅链接、已确认计划提交、作业查询、外部候选导入、接受及 JSON/PNG 导出。常规工具不提供 ZIP 交接，也不提供冒充用户的确认工具。写入需带当前 revision；任务提交使用 UUID 幂等键。工具错误明确返回 `isError`。

默认 `canvas_observe` 和 PNG 导出拒绝提供图片。用户在编辑器的“项目图像授权”中选定实际分析客户端并明确授权后，工具才可使用对应 `grantId`。`MASKCANVAS_AGENT_CLIENT` 来自受信本机 MCP 配置，可为 `client:codex`、`client:workbuddy`、`client:qoder`、`client:external-agent`；调用参数不能冒用另一身份。旧 `MASKCANVAS_ALLOW_AGENT_IMAGES` 开关不再授予整库照片访问。

照片授权绑定当前基准，撤销/过期/换基准后失效。结构化 JSON 操作不需要提供图片。客户端标识不证明其模型位于本地。授权限制产品 MCP 的图像提供和作业提交；本机文件、Shell、原始 loopback HTTP 是受信工作区边界，不是恶意本机程序的沙箱。照片、裁切和缩略图均可能含隐私。

跨工作区移交时先独立导入对应图片，再在 JSON 交接页明确勾选“绑定到当前照片”，或使用 `canvas_rebind_json` 指定目标项目。服务核对规范基准 PNG 的 SHA-256、尺寸与坐标，不读取 JSON 中任意路径；成功也只生成待审草稿。若规范 PNG 字节不同，必须显式检查图片来源，不按相同尺寸放行。

## 首版限制

暂无 RAW/16-bit 专业显影、自动识别与分割、完整自主策略、后台服务安装、三客户端自动配置或团队协作。GPT 仅完成节点schema和模拟集成，未做真实付费生成。生成产物尺寸与范围检查不自动证明身份、姿态或纹理自然度；接受前必须目视检查。候选不满意可拒绝，图像与历史仍保留。

最新标注/计划 JSON 协议、用户确认与 Agent 续跑契约见 [agent-workflow.md](agent-workflow.md)。真实验证状态以 [development-progress.md](development-progress.md) 为准，接口存在不代表所有后端与三个客户端均已验收。
