# JSON 交接与 Agent 发起的确认流程

更新：2026-10-22。用户本次要求优先于旧“ZIP 编辑包交接”设计。**常规交接使用 JSON，不要求压缩包。**

## 1. 数据分工

照片是独立文件/资产。JSON 描述图片引用、哈希、原图坐标、区域、保护、意图、版本，以及后续任务/结果引用。矩形、笔画、多边形和擦除操作都可完整保存在 JSON，执行时才生成后端所需的 mask PNG。

图片字节不默认转成大段 base64 塞进聊天；这不会减少信息量，还会增加复制和上下文成本。需要复杂分割蒙版时，应使用精确可解码的表示或资产引用，不能用粗框冒充精细蒙版。

同机不同 Agent 连接同一 MaskCanvas 时，可直接解析项目/资产引用。跨设备时必须先让目标工作区取得图片，并显式绑定基准；仅有引用的 JSON 不能恢复不存在的图像。JSON 里的文件路径或 URI 也不自动获得任意文件读取权限。

## 2. 本次已落地：标注 JSON v1

| 字段 | 作用 |
|---|---|
| `format / schemaVersion` | `maskcanvas.annotations / 1`，明确协议版本 |
| `projectId` | 所属工作区项目 |
| `baseVersionId / revision` | 避免误改旧照片或覆盖后续人工修改 |
| `image.assetUri` | 本地资产引用，不是自动上传 URL |
| `image.sha256` | 当前归一化基准 PNG 的哈希 |
| `image.width / height` | 原图坐标尺寸 |
| `image.coordinates` | `original-pixels`，不使用屏幕坐标 |
| `image.colourSpace` | 首版固定明确的 `srgb` 基准 |
| `regions[]` | 名称、edit/keep、局部意图、向内羽化、geometry 与 subtract |

例子仅用于解释协议，项目/哈希在实际使用时由服务生成：

```json
{
  "format": "maskcanvas.annotations",
  "schemaVersion": 1,
  "projectId": "11111111-1111-4111-8111-111111111111",
  "baseVersionId": "source-example",
  "revision": 3,
  "image": {
    "assetUri": "maskcanvas://projects/11111111-1111-4111-8111-111111111111/assets/source-example.png",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "width": 1536,
    "height": 1024,
    "colourSpace": "srgb",
    "coordinates": "original-pixels"
  },
  "regions": [
    {
      "id": "hair-1",
      "name": "发丝建议区域",
      "kind": "edit",
      "intent": "清理碎发，保留发型、发际线与脸型",
      "feather": 4,
      "shapes": [
        { "type": "polygon", "points": [ { "x": 220, "y": 130 }, { "x": 290, "y": 120 }, { "x": 275, "y": 220 } ] }
      ]
    }
  ]
}
```

普通标注导入要求同项目、同图片哈希、同基准与 revision，完整校验几何；只载入标注，不触发图像生成，也不代表用户已确认计划。跨项目/设备改用显式图片绑定，不能静默改写这些字段。独立提议草稿采用下节的计划 JSON。

### 已有入口

- UI：查看/复制标注 JSON、下载 `.json`、文件导入与粘贴导入；导出先保存本地标注。
- HTTP：GET/POST `/api/projects/:id/annotations`，沿用本地 Host/Origin 与 session 写入保护。
- MCP：`canvas_get_annotations`、`canvas_import_annotations`；`canvas_export` 支持 `json`/`png`。
- MCP：`canvas_open_editor` 返回项目链接与当前 revision，Agent 可用自己的浏览器/打开链接能力展示给用户；工具本身不偷偷控制浏览器，也不提交生成。

旧 ZIP 函数和 HTTP 接口只保留为内部历史兼容，不再作为 UI/MCP 的日常交接方式。旧图稿 S07 是历史示意，交接以此文档与当前应用为准。

## 3. 计划 JSON 与确认流程

`maskcanvas.proposal / 1` 是建议审阅与 Agent 续跑使用的 JSON。顶层有 `projectId`、`image` 和 `proposal`；图片引用与哈希对应这份建议的基准，即使建议过期也不会错误引用最新照片。

| 对象 | 内容 |
|---|---|
| `image` | 与标注 JSON 相同的资产引用、哈希、尺寸、色彩和坐标系统 |
| `proposal` | ID、名称、目标、来源、后端、基准、项目与计划修订、区域、建议及当前状态 |
| `proposal.suggestions[]` | 每个 edit 对应一个原因、启用开关及可选置信度；全部 keep 保留 |
| `proposal.confirmation` | 服务端生成的确认 ID、时间、计划/项目修订与快照指纹；导出时供查询和追踪 |

草稿保存在项目独立的 `proposals.json`，创建与修改不会覆盖人工正式标注。草稿继承已有保护区，用户在画布确认后，启用的 edit 与全部 keep 按区域 ID 合并到正式标注，保留其他已有人工区域。只有本计划启用的 edit 获得执行资格，其他人工编辑区不会顺带生成。取消确认只撤销执行资格，不回滚正式标注或覆盖之后的人工修改。

取消只停止后续生成；已经完成且仍符合基准/标注的候选可以保留，由用户另行决定是否接受。已受理过程中失效的最终结果会标记为过期候选，不能接受。已有保护区的 ID 不能在提议中改成 edit。

确认操作推进计划和项目修订，迟到的旧修改/取消请求会返回冲突。确认先准备记录、再提交正式区域；若进程在提交前中断，恢复读取时显示为可重新确认的草稿，不能获得执行资格。

启用处理配置的服务还会在确认中冻结实际 Comfy 中转 origin 与模型 ID；配置变化后旧确认失效。GPT 最终云服务路由由中转节点私有配置决定，不用任意声明的云地址冒充已验证目的地。GPT 作业须额外匹配当前项目的生成授权；分析授权单独授予指定客户端。

计划、正式标注或基准改变后，旧确认失效。MCP 不提供确认工具；正常协同流程由用户在编辑器中确认。JSON 中带出的 `status` 或 `confirmation` 不可作为导入授权，导入永远创建新草稿，并继续校验当前图片及修订。已确认的旧导出若修订落后，会拒绝导入，需先读取当前项目，显式创建新草稿。

接口：GET `/api/projects/:id/proposals/:proposalId/document`；POST `/api/projects/:id/proposal-documents`（`{ "document": ... }`）。常规续跑直接查询同一建议，无需反复下载或粘贴文件。

### 协同路径

1. **用户在 Agent 里给一张照片并说明目标。** 由当前 Agent 观察照片，不要求工作台再内置另一套聊天模型。附件必须能由该客户端转为可导入文件/资产；只存在聊天侧的引用需先解析。
2. **导入工作台，取得规范基准。** 返回尺寸、方向归一化信息、基准版本与可观察资源。Agent 观察和坐标生成以该基准为准，避免 EXIF 或预览缩放造成区域错位。
3. **Agent 创建“待确认建议”。** 每项包含问题、修饰目标、建议方法、区域、保护对象和可选置信信息。粗定位可先给框，精细范围通过分割或人工修正；不默认改变五官或体型。
4. **打开编辑器展示建议。** Agent 使用编辑器链接展示照片与可选建议列表。人可以删除、禁用某项，重画边界、补保护、改变修饰强度/方向。Agent 建议不能直接覆盖现有人工标注。
5. **用户确认当前计划。** 服务端冻结对应基准、revision、区域/保护、后端参数与处理目的地，记录确认。后续改变这些内容时，旧确认失效。
6. **Agent 读取确认状态后执行。** 异步查询原计划/作业 ID，不要求反复复制 JSON，也不靠长期阻塞的 MCP 调用等待。不要信任一份外部 JSON 中自行填写的 `confirmed: true`。
7. **候选回到编辑器验收。** 实际范围检查与原尺寸视觉检查通过后接受；不满意回到对应建议修改，保留历史。

人工先标注的路径也使用相同 JSON 与确认/任务对象；自主模式是用户在一开始授予范围明确的自动执行策略，而不是省略版本、保护和验收。

### MCP 调用顺序

1. `canvas_open`：导入用户明确给出的本机图片，返回项目、规范图片引用/哈希及编辑器链接。当前 Agent 对规范基准进行观察，图像分享需有对应目的地授权。
2. `canvas_create_proposal`：传入当前 `baseVersionId / projectRevision`、原图坐标区域与建议；来源由工具固定为 `agent`。
3. `canvas_open_editor(projectId, proposalId)`：返回对应建议链接。调用方使用自己的打开页面能力展示，不要求用户搬运 ZIP。
4. `canvas_get_proposal`：返回完整计划 JSON。等待用户确认；修改时用 `canvas_update_proposal`，修改会撤销旧确认。
5. `canvas_submit_plan(projectId, proposalId, confirmationId, idempotencyKey)`：仅按服务端有效确认执行。`canvas_submit_qwen` 是相同确认契约的兼容名称，不能无确认提交。
6. `canvas_get_job / canvas_list_jobs`：重连后查询原任务。不要因为超时更换幂等键。
7. 范围与原尺寸视觉验收后 `canvas_accept`；需要文件时 `canvas_export` 导出 JSON 或接受版 PNG。

`canvas_get_annotations / canvas_import_annotations / canvas_set_regions` 保留人工标注交接；它们不创建确认，也不触发生成。Agent 提出修饰建议时应使用 proposal 路径，不能以覆盖正式标注替代审阅。

### 显式图片绑定

把照片作为独立文件导入目标工作区后，使用 `POST /api/projects/:id/rebind-json`（`{document}`）或 `canvas_rebind_json(targetProjectId, document)`；UI 的 JSON 交接页提供默认关闭的绑定选项。服务比对目标规范基准 PNG 的 SHA-256、尺寸、sRGB 与原图坐标，不能只比尺寸。不会读取源 URI 或任意路径。PNG 编码字节不同即拒绝，需核对或使用同一规范基准。

通过后将外来标注/建议转换为目标当前基准的新草稿，忽略所有外来确认/授权；冲突区域 ID 重映射，保留目标人工区域。返回来源与目标项目、基准和修订供调用方记录；此来源说明不额外持久化为审计日志。图像本身仍独立传递，JSON 不包含 base64 照片。

人工单区域入口仍可在编辑器由使用者点击生成，其作业明确标记 `source=human / submissionMode=manual-region`。这是使用者对当前单区的即时授权；Agent 的 MCP 入口统一要求已确认计划。此约定不把本机 HTTP 会话当成能防范恶意本机程序的权限隔离层。

## 4. 迭代优先级与完成标准

| 顺序 | 工作项 | 完成标准 |
|---|---|---|
| A | JSON 标注交接 | 本轮已实现：复制/下载/导入、MCP、哈希与版本检查；导入不生成 |
| B | 独立 Agent 建议草稿 | 已实现并通过浏览器：不覆盖人工标注，显示建议/目标/边界并允许修改 |
| C | 用户确认与失效规则 | 已实现并通过测试：服务端确认、编辑失效、伪造确认拒绝、迟到请求冲突、中断恢复 |
| D | Agent 续跑 | 已通过真实 MCP + Qwen 两步任务：查询确认、按快照执行、同幂等键去重、一个合并候选 |
| E | 一个实际客户端闭环 | 先在 Codex 或用户选定的一个客户端跑“给图 → 建议 → 用户调整 → 确认 → 候选”；再扩展其他客户端 |
| F | 精细分割与双后端 | 在主交互成立后补齐发丝/衣物分割、Qwen 真实效果和 GPT 能力 |

**当前迭代聚焦 B+C+D。** 代码、模拟协议测试、实际浏览器和真实生成分别记录证据；真实生成或客户端尚未实测时，不能用代码存在代替交付验收。不增加更多滤镜、批量功能或聊天界面，也不把 ZIP 移交作为主交互。
