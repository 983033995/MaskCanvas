# 选区工具修复与成熟编辑器交互借鉴

日期：2026-10-22。

## 已实现

1. 统一 CSS/原图/设备像素换算，移除离屏蒙版合成的重复 DPR 缩放；监听屏幕 DPR 变化。
2. 画笔和橡皮显示黑白描边圆形笔尖，直径随原图笔刷尺寸和当前缩放变化；顶部可改直径，`[` / `]` 快捷调整。
3. 画笔按下即预览，拖动连续显示；橡皮把草稿合入当前区域的 subtract 运算，松手前便能看到擦除，松手不换一套渲染方法。
4. 加入磁性套索、自由套索和多边形套索。磁性模式点击起点后沿边缘移动，自动/手动锚点、Backspace 回退、Alt 暂停吸附、Enter/双击/回起点闭合、Esc 取消。
5. 新增吸附范围与边缘对比调节；使用 RGB 梯度与局部最小代价路径，而不是只把两个点击位置连成直线。
6. 空格/中键可临时平移；滚轮围绕指针缩放，已有标注仍保留原图坐标。

照片边缘处保持鼠标中心不变，只裁切超出部分；对应服务端保存规则已修改并通过测试。用户授权后已正常重启 MaskCanvas，现场 HTTP 验收确认边缘画笔与橡皮可保存并正确合成。

## 依据

- [Photoshop 磁性套索](https://helpx.adobe.com/photoshop/desktop/make-selections/freehand-selections/snap-to-image-edges-using-magnetic-lasso-tool.html)：借鉴检测宽度、对比度、沿边移动和锚点闭合交互。
- [Photoshop 绘画光标](https://helpx.adobe.com/photoshop/desktop/apply-painting-techniques/brushes-presets/set-cursor-preferences-for-painting-tools.html)：借鉴按笔尖尺寸反馈光标范围。
- [GIMP 智能剪刀](https://docs.gimp.org/3.0/en/gimp-tool-iscissors.html)：借鉴边缘跟踪、锚点回退和人工修正路径。
- [MDN Canvas 性能与 HiDPI](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)：区分 CSS 尺寸与物理 backing store，避免缩放重复。

没有复制这些软件源码，也不宣称完全复现 Photoshop 的专有算法。

## 验证

- 自动化测试：坐标 round-trip、同亮度不同色彩边界、弯曲边缘、弱/无边缘回退、边缘笔刷裁切等，累计 21 项通过。
- 浏览器实际 Canvas：DPR 1/2/3 渲染位置与擦除孔洞检查。
- 原生指针操作：DPR 1/2 × fit、100%、放大+平移共六组；按住、拖动、松手处同一采样位置的变化一致，保存的首点误差小于 0.1 原图像素。
- 橡皮按住未松手时恢复背景像素；笔尖直径随缩放正确变化（含描边容差）。
- 磁性套索在合成色块边界产生 1113 点 polygon，全部位于预期边界 4 像素范围内；已验证回退、闭合、取消与自由套索。

结果见 `evidence/iteration-02/selection-browser-results.json`，截图见同目录。

## 范围限制

磁性套索分析图长边上限 2048，输出仍为原图坐标；弱对比、同色衣物/背景、半透明发丝等处可能吸错边，应调检测范围/对比度、手动加锚点，或切自由套索后用画笔修正。合成色块测试不是所有真实照片的抠图质量保证。

本轮没有新增云服务、AI 分割模型或 ComfyUI 任务。重启只涉及 MaskCanvas，未刷新用户页面；重启前 8 个项目的 project.json 哈希均保持不变。现场边缘保存与合成报告见 `evidence/iteration-02/restart-verification.json`。
