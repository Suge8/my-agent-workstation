# 截图管线（原始截图 → HTML 合成 → 平台成图）

## 按项目类型取原始截图

| 项目类型 | 工具 | 要点 |
|---|---|---|
| Web | flow-browser-use | 设精确视口 + 2x deviceScaleFactor 直出高清；亮/暗两套 |
| 浏览器扩展 | Playwright `launchPersistentContext` + `--load-extension` | popup/sidepanel 有 URL 可直接开页截图；UI 若由 IndexedDB/Dexie 重建，seed 数据库造真实感会话比驱动真实操作稳 |
| 桌面 app | 原生 `screencapture -l <窗口ID>` | 先把窗口 set 到目标尺寸再截；带系统圆角阴影版直接用，进 HTML 合成用 `-o` 去阴影版 |
| CLI / TUI | `freeze --execute "<命令>"` 或 freeze 截取输出 | 直出带窗口 chrome 的精美 SVG/PNG |

桌面窗口：先 set 尺寸，再按 `-l <CGWindowID>` 截指定窗口（被遮挡也能截、不抢焦点）。

```bash
osascript -e 'tell app "System Events" to set size of window 1 of process "CuePad" to {1280, 800}'
screencapture -o -l <CGWindowID> raw.png
# 可靠取 CGWindowID：AppleScript 的 window id ≠ CGWindowID、python3 常无 Quartz，最稳用 Swift 按 PID
swift - "$(pgrep -x '进程名')" <<'SWIFT'
import CoreGraphics
let pid = Int(CommandLine.arguments[1])!
let ws = (CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements], kCGNullWindowID) as! [[String:Any]])
  .filter { $0["kCGWindowOwnerPID"] as? Int == pid && $0["kCGWindowLayer"] as? Int == 0 }
print(ws.max { ($0["kCGWindowBounds"] as! [String:Double])["Width"]! < ($1["kCGWindowBounds"] as! [String:Double])["Width"]! }?["kCGWindowNumber"] as? Int ?? 0)
SWIFT
```

**原始截图纪律**：真实感数据（有内容的会话/列表，不是空状态和 lorem）；界面收拾干净（关无关弹窗、满电池心态）；同一批物料用同一套数据保持连贯。

## HTML 合成管线（从"能看"到"能宣传"的关键一步）

写一个本地临时 HTML：目标平台精确尺寸的画布 + 背景（VISUAL 链 B 的底图，或 CSS 渐变）+ 截图（圆角 + 阴影 + 可选轻微透视）+ 标题文案（copywriting 出、stop-slop 过，字体色板沿用现有品牌或界面）→ flow-browser-use 按画布尺寸整屏截图 → 成图。

要点：截图放 2x 源图缩小显示才锐利；文案层级最多两级（大标题 + 一行副题）；构图留呼吸感，宁空勿挤。

零依赖出图：数据驱动写临时 HTML，headless Chrome 按精确尺寸直接截，不用 Playwright。

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --screenshot=out.png --window-size=1280,640 \
  --force-device-scale-factor=1 --hide-scrollbars \
  --default-background-color=00000000 file:///tmp/canvas.html
```

关键手法：画布按目标尺寸 1:1 布局；截图 `<img>` 放 2x 源图靠 CSS 缩小才锐；logo 免抠图——白底黑标用 `mix-blend-mode:multiply`、黑底白标用 `screen`。

## 平台尺寸表（成图必须精确匹配）

| 目标 | 尺寸 | 备注 |
|---|---|---|
| GitHub social preview | 1280×640 | 仓库 Settings 上传 |
| OG / Twitter card | 1200×630 | 官网 meta 用 |
| README hero | 2400×1260 出图 | 显示 1200 宽，2x 防糊 |
| Chrome Web Store 截图 | 1280×800 | 备 640×400 小版 |
| Chrome Web Store 宣传图 | 440×280 | 小而精，单焦点 |
| Product Hunt gallery | 1270×760 | 首图决定点击率 |
| App Store (macOS) | 2880×1800 | 桌面 app 上架用 |
| 社媒方图 | 1080×1080 | 通用 |

与 set-test-chain 的取证截图区分：那边求快求真，这边求美——别混用产物。
