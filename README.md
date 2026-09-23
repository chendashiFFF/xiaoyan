# Xiaoyan Desktop Pet

这是 Xiaoyan 角色的 macOS / Windows 桌面宠物原型。窗口是透明、无边框、置顶的小窗口，人物可以拖动；点击人物会挥手，悬停时会显示动作和缩放控制，右键可以直接选择动作或退出。

## 已接入的动作

- 正面待机（4 帧）
- 正面挥手（6 帧）
- 正面施法（6 帧）
- 正面攻击（6 帧）
- 正面受击（4 帧）
- 三分之二侧跑（8 帧）
- 正面跳跃（6 帧）
- 正面鞠躬（4 帧）
- 正面舞蹈（8 帧）
- 正面坐下（4 帧）
- 正面困倦（4 帧）
- 正面转身（6 帧，含侧面和背面参考）
- 正面鼓掌（6 帧）
- 正面惊讶（4 帧）
- 正面难过（4 帧）

动作帧在 `assets/actions/`，透明母图、品红处理母图和角色设计参考在 `assets/references/`；桌面端运行只读取处理后的透明动作帧，参考图保留在项目里方便继续生成新动作。

动作状态机在动作结束后自动回到待机，切换帧前会预加载全部 PNG，并用原子切帧避免透明叠帧造成闪烁；跑动会在屏幕工作区边界反弹。动作和窗口位移分离，避免脚步帧与窗口移动互相干扰。人物大小支持 75% 到 300%，使用 0.25 倍步进；快捷键 `+`、`-`、`0` 也可以调整。

## 本地运行

```bash
npm install
npm run dev
```

只想在浏览器里预览动作时，运行：

```bash
npm run web
```

然后打开 `http://localhost:4173/src/renderer/index.html`。浏览器模式会用网页拖动和网页内移动回退实现，不依赖 Electron 的窗口通信。

## 打包

在 macOS 上生成 DMG 和 zip：

```bash
npm run dist:mac
```

Apple Silicon 使用 `npm run dist:mac:arm64`；Intel Mac 使用 `npm run dist:mac:x64`。

在 Windows 上生成 NSIS 安装包和 portable 版本：

```bash
npm run dist:win
```

当前电脑是 Apple Silicon 时，`npm run dist:win` 会默认生成 Windows ARM64；给普通 Intel/AMD Windows 电脑打包时使用：

```bash
npm run dist:win:x64
```

## 动作帧的清晰度

动作帧是带透明通道的 PNG，统一为 256×256 帧并用脚底锚点对齐。渲染层使用整数倍缩放和像素化采样，因此放大时不会被浏览器的双线性插值弄糊；如果后续需要更大的显示尺寸，可以将动作源帧统一升级到更高的 cell-size，再保持同一套锚点和状态机。

## 许可证

MIT License，见 [LICENSE](./LICENSE)。
