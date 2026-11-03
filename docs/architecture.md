# MaskCanvas 架构方案 v2

更新：2026-10-22。本地像素核心、文件项目、基础画布、stdio MCP 与 Qwen 作业适配已落地；真实生成与完整自主能力仍待验收。需求见 [requirements.md](requirements.md)，当前状态见 [development-progress.md](development-progress.md)。未标完成的段落仍为目标架构。

## 产品边界

普通浏览器画布与不同 Agent 的 MCP 入口连接同一编辑核心。控制端管理资产与版本，Windows ComfyUI 为执行节点之一；前端不直接处理跨机器路径和上游凭据。

| 层 | 职责 |
|---|---|
| 画布 | 查看照片、编辑/保护 mask、局部意图、对比与接管 |
| MCP | 能力发现、观察、建区、计划、任务、候选、验收与交接 |
| 编辑核心 | 坐标、范围、合成、版本冲突、作业持久化与规则 |
| 项目存储 | 原始资产、基准、mask、输入快照、候选、报告 |
| 适配器 | Qwen/ComfyUI、GPT Image，以及可选检测/分割服务 |

## 技术选型方向

自有画布若确有必要，延续 React、TypeScript、Vite 的方向，画布库通过大图/蒙版试验后确定。服务端同语言或复用现有适配服务均可；不因设计稿先锁死依赖版本。存储优先项目文件与明确 schema，暂不引入云数据库。

InpaintCanvas 先作为现成候选做差距验证，尤其核对其本地命令路由、后台 Chromium、大图导出、保护语义和跨设备桥接。优先外部适配，不直接复制上游代码进 MIT 项目。

## 最小领域对象

| 对象 | 关键字段与规则 |
|---|---|
| Asset | 内容哈希、相对路径、格式、尺寸、方向和色彩；原始文件不可变 |
| Project | 当前接受版本、标注 revision、任务策略、目的地权限 |
| Region | id、名称、来源、人/Agent、operation、intent、mask 引用 |
| EditPlan | base_version、annotation_revision、区域顺序、后端偏好、范围与预算 |
| Job | 提交幂等 ID、外部 prompt/job ID、输入快照、持久化状态 |
| Candidate | 基准引用、生成原料、变换链、合成结果、验收报告 |
| Version | 接受的不可变候选；原图永远保留；可产生新编辑基准 |
| Handoff | JSON：schema、资产引用/哈希、区域、任务与结果引用；图片为独立文件，不含凭据或执行脚本 |

## 范围与合成

E=允许编辑、K=硬保护、C=模型上下文。C 只影响模型可见信息；有效 alpha 必须限制在 E−K。crop 记录原图偏移、缩放和方向变换，模型尺寸网格取整也必须回投校验。

羽化向内；校色只在有效范围内；全部处理之后恢复 K 与有效 alpha 为零的基准像素。对相同无损基准检查 `protected_changed_pixels`、`outside_edit_changed_pixels` 和最大通道差。

生成结果比例异常、人物移动或无法对齐时成为待处理候选，不自动拉伸提交。多个不同意图的重叠区域需要明确先后；不可简单合并 prompt 一次重绘。

## 版本与并发

任务提交冻结基准和标注快照；执行中仍可编辑，但新标注不修改已提交任务。接受结果要比较 base_version 与 revision。基准过期时保留为分支候选，由用户或符合策略的 Agent 决定重新执行；不使用 last-write-wins。

## 后端协议

能力探测分别报告：本地/远端、图像编辑、mask、参考图、返回尺寸、seed/强度是否支持。后端统一执行“准备输入 → 提交 → 查询 → 获取候选”，不承担最终保护保证。

ComfyUI 使用已有 HTTP/WS API 与 API 格式工作流，记录实际 prompt ID。GPT 路线必须核实自定义节点和官方节点的不同能力；不得仅凭模型下拉列表认定可用。具体服务状态在实施时重新检查。

## 作业状态

`draft → ready → queued → running → validating → candidate`；明确失败为 `failed`，不确定受理/断线为 `reconciling`。候选可接受、拒绝或进入冲突/需要人工状态。取消请求与实际取消分别记录；不能把“发出取消”当完成。

共享 GPU 时查询队列但不全局 interrupt、clear 或释放他人任务。未知状态先恢复查询，不重复提交；可恢复信息存盘，不只存在聊天记录。

## MCP 接口组

拟议分组而非现有可执行工具：capabilities、project/observe、regions/plan、jobs、candidates/versions、validation、handoff/import/export。

输入含 project_id、基准/revision 和资产引用；写入使用并发检查；任务提交使用幂等 ID。stdio 适配客户端优先，认证 Streamable HTTP 按需要增加；多个客户端应连接同一编辑核心。

返回结构化 JSON，可附图像内容/资源；无视觉能力的客户端只执行标注，不冒充视觉验收。MCP Apps 内嵌界面是可选增强，普通浏览器画布始终独立可用。

## 安全与隐私

默认控制端绑定 loopback。跨设备服务通过已有个人私网/受控桥接及认证，不为方便修改为公网裸露。验证来源、认证与项目访问边界，图片资源受与工具相同的权限约束。

图像分析与生成目的地分开控制；缩略图和 crop 同样受权限检查。凭据只在适配器运行环境，工具响应、图稿、包和日志不得包含密钥。日志记录任务状态与必要错误，不默认记录照片或完整敏感提示词。

## 待实现验证

坐标/蒙版/合成/版本用确定性测试；异步适配用模拟失败与恢复；再用非私人素材验证两个后端、三客户端与三模式。专业色彩、RAW、16-bit 和复杂图层另列阶段。

## JSON 与建议确认流程修订

日常交接只用 JSON。`server/annotations.ts` 负责标注 JSON；`server/proposal-document.ts` 负责计划 JSON；两者都有图片引用/哈希与基准修订。`server/proposals.ts` 独立保存建议草稿、用户修订和确认记录，计划任务绑定确认快照，关键输入变化后失效。多区域执行保存每步的不可变输入/合成结果，最终只产生一个候选。UI 与 MCP 共用 HTTP 核心和同一 ProposalStore，ZIP 仅留底层历史兼容。详见 [agent-workflow.md](agent-workflow.md)。
