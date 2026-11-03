# MaskCanvas 开发约定

本项目是独立照片精修工作台。按 `docs/requirements.md` 实现，视觉参考 `design/v2/`；旧设计不作为新功能的视觉目标。当前为 0.1 迭代，不能把设计目标写成已实现能力。

## 结构与命令

- `app/`：React/Vite 画布、项目、区域与候选界面。
- `server/store.ts`：项目、原图坐标 mask、合成、验收、版本与包。
- `server/qwen.ts`：本地 ComfyUI 编辑作业与恢复。
- `server/gpt.ts`：现有 ComfyUI GPT 节点的工作流与真实 schema 校验；不自行配置凭据。
- `server/permissions.ts` / `server/rebinding.ts`：项目图像授权与显式 JSON 图片绑定。
- `server/proposals.ts` / `server/proposal-document.ts`：独立建议、确认快照及计划 JSON。
- `mcp/`：stdio 包装，共用 HTTP 编辑核心，不另建项目库。
- `packages/shared/types.ts`：浏览器/核心/MCP 共享 DTO。
- `rtk npm test`：Node/tsx 确定性测试、HTTP 与真实 MCP transport 测试。
- `rtk npm run build`：TypeScript 检查与 Vite 生产构建。单跑 typecheck 不代表页面可启动。
- `rtk npm run dev`：loopback Vite + 本地 API。
- `rtk npm start`：构建后在 `127.0.0.1:7317` 提供 UI/API。

## 不变量

1. 图像/区域使用原图坐标；context 不是编辑权限。向内羽化，最终 keep 与范围外像素不变。
2. 生成只产生候选；接受前读取实际资产重算验收，不信任导入包的报告。
3. 原图、接受历史不可覆盖。任务保存 base/revision/region 快照；过期候选不得静默接受。
4. 外部任务提交前持久化 ID，不确定时查询，不自动换幂等键重发。不以显示名识别作业产物。
5. 不重启/修改已有 ComfyUI 服务，不全局 interrupt、清队列或取消其他项目作业。
6. GPT 与视觉尚未接通时明确不可用，不制造任务、在线状态或检查数值。
7. API 绑定 loopback，session 与照片读取同样检查 Host/Origin。凭据不进代码/包/日志。
8. `projects/` 包含用户照片和运行状态，始终忽略；测试用临时独立目录，不能扫描或清理用户照片目录。
9. Agent 日常交接只用 JSON（图片引用/哈希、基准/revision、原图坐标区域和意图），不再要求 ZIP。图片仍是独立资产。下一步建议草稿与用户确认必须分离，不能把外部 JSON 的 confirmed 字段当授权。
10. 确认合并保留其他人工区域，仅启用的计划 edit 获得执行资格；不能把既有 keep 的 ID 改作 edit。确认推进计划修订，旧修改请求不得撤销新确认。
11. 多步恢复输入读取独立的上一步合成文件，不能从会被本步骤覆盖的中间图重放；每步生成前重新核对确认，受理不明不重发。范围通过不代表视觉效果通过。
12. MCP 观察和 PNG 导出均检查项目授权，客户端身份取可信本机配置，不能由工具参数冒用。GPT 目的地表示实际 Comfy 中转 origin，不能用声明的云 URL 冒充已验证的最终路由。该产品权限不是本机文件/原始 HTTP 的安全沙箱。
13. GPU 忙时 queued 作业必须返回可见等待原因，不能只有“排队中”。服务端自动续跑和会话通知分别验收；前端轮询不等于 Agent 会话自动唤醒，长时任务按原任务 ID 安排可靠跟进。

## 验证与交付

每轮更新 `docs/development-progress.md`，写已完成、实跑验证与下轮阻塞。前端交互验收使用用户指定的 ego-browser/@Chrome，禁止 Playwright。合成示例用于验证，不把外部候选的合成测试说成 AI 编辑效果实测。浏览器截图与视觉对比记录在 `docs/evidence/` 和 `design-qa.md`。
