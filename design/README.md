# MaskCanvas — Design Files

## 可交互主界面

- `ui-mockup.html` — 单文件、无后端的可交互 UI 稿（点击工具、区域卡、对比、Protect/History 标签、生成按钮、导出弹层）。
- 直接双击打开，或在本目录启动本地静态服务：

```bash
cd /Volumes/13759427003/AI/MaskCanvas/design
python3 -m http.server 8765 --bind 127.0.0.1
# http://127.0.0.1:8765/ui-mockup.html
```

## 截图

- `ui-mockup.png` — 默认编辑状态（R1 展开、R2/K1 折叠、生成参数、filmstrip）。
- `ui-mockup-compare.png` — 原图/结果分割对比（蒙版自动隐藏）。
- `ui-mockup-protect.png` — 保护区域标签（K1 宝宝脸部、K2 男士/手臂、K3 背景/气泡）。

## 图片占位

`portrait-placeholder.png` 是为 UI 稿生成的**合成人像示意图**，不是实际家庭照，也不包含任何真实人物。它只用于展示画布、蒙版和对比效果。

## 说明

- UI 稿里的“生成”是模拟状态（约 2.8 秒后出现 V4 候选），不调用 ComfyUI。
- 所有区域、版本、Agent 状态都是演示数据。
- 设计规范见 `../docs/ui-spec.md`，交互路线见 `../docs/interaction-roadmap.md`。
