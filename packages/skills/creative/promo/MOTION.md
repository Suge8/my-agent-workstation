# 动态物料（演示 GIF / 视频）

## 按项目类型选录制方案

| 项目类型 | 方案 | 自动化程度 |
|---|---|---|
| Web / 浏览器扩展 | Playwright 脚本驱动操作 + `recordVideo` 录制 | 全自动，可重复 |
| CLI / TUI | **VHS**：写 .tape 脚本直出 GIF/MP4 | 全自动，改脚本重跑即可 |
| 桌面 app | `screencapture -v -l <CGWindowID> out.mov` 录指定窗口（被遮挡也录、不抢焦点；窗口 ID 获取见 SHOTS.md 桌面块）+ better-computer-use 驱动 | **实验性**：bcu 未实测，首次做好人工搭手准备 |

## 浏览器扩展录制：先过授权关

真实站点上跑扩展 demo，得先拿到站点权限，全是坑：

- CDP `Extensions.loadUnpacked` 装的扩展是会话级，optional 授权每次启动重置——授权序列要在每次 launch 后重跑。
- 别离线改 `Secure Preferences`（有 MAC 校验会被 Chrome 打回）。正路：`developerPrivate.addHostPermission` 预登记通配 host + `developerPrivate.updateExtensionConfiguration` 开 userScripts，之后 headless 下 `permissions.request` 静默自动授予（无原生气泡）并写进 profile。
- Chrome 137+ 砍了 `--load-extension` 只能 CDP 装；反检测浏览器（如 CloakBrowser）会随机化 tab id 误杀 target tab，录扩展用原生 Chrome。

## VHS（pi / pi-flow 的演示利器）

```tape
# demo.tape → vhs demo.tape
Output demo.gif
Set Width 1200
Set Height 680
Set FontSize 18
Set Padding 20
Type "pi"
Enter
Sleep 2s
Type "帮我审查这个模块"
Enter
Sleep 6s
```

要点：脚本就是事实源，演示词改一版重跑一版；`Sleep` 要给足输出时间（跑一遍真实命令看耗时再定）；主题跟终端配色一致。

## Playwright 录制要点

- viewport 设 1280×720（README/社媒通用），`recordVideo.size` 同尺寸
- 操作节奏放慢：关键点击之间 `waitForTimeout(800)`，机器速度的演示人眼跟不上
- 光标可见性差是常见问题：关键操作前后用 hover 停顿制造视觉锚点

## ffmpeg 后期配方（已装）

```bash
# MP4 → 高质量 GIF（两趟调色板法，质量远好于直转）
ffmpeg -i in.mp4 -vf "fps=12,scale=960:-1:flags=lanczos,palettegen" /tmp/pal.png
ffmpeg -i in.mp4 -i /tmp/pal.png -filter_complex "fps=12,scale=960:-1:flags=lanczos[x];[x][1:v]paletteuse" out.gif

# 加速 1.5x（演示嫌慢时）
ffmpeg -i in.mp4 -filter:v "setpts=PTS/1.5" -an fast.mp4

# 裁掉首尾（开头启动画面、结尾收尾）
ffmpeg -ss 2 -to 18 -i in.mp4 -c copy trim.mp4
```

## 产物规格

- README 里：GIF ≤ 10MB（超了降 fps 到 10 或宽度到 800），或 MP4 上传 GitHub 附件后引用
- 社媒：MP4（X 上限 2:20，实际 30-60s 最佳）
- 商店：查各商店当前要求，MP4 为主
- 落盘 `design/promo/motion/`，保留 .tape 和 Playwright 脚本——它们是可重跑的源，视频只是产物
