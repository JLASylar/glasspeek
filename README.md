# GlassPeek

GlassPeek 是一个 Firefox 扩展：长按、拖拽或按住修饰键点击链接，在当前页面上弹出一个小窗口预览目标网页，不用离开当前页。需要 Firefox 153 或更高版本。

源码托管在 [GitHub](https://github.com/JLASylar/glasspeek)。签名安装包见仓库的 Releases 页面。

## 工作方式

- **兼容处理只作用于当前预览树，且只为直接目标放宽。** GlassPeek 只对经过标签页、祖先 document ID 和 frame ID 校验的当前目标框架无条件移除 `X-Frame-Options`，并只从 CSP 与 CSP Report-Only 中移除 `frame-ancestors`。被预览页面自己再嵌入的更深层 iframe 按“直接目标就是顶层页面”来模拟判断：`DENY` 与 `frame-ancestors 'none'` 一律保留，`SAMEORIGIN` / `'self'` 和其他来源列表只在模拟祖先链已经满足时才移除（详见“安全结构”）。普通标签页、同页其他框架以及 CSP 的其余指令均不受影响。
- **失败时明确提示。** 网站禁止嵌入、导航出错或等待超时时，预览不会把 iframe 的 `load` 事件误报成成功；界面会停留在清晰的失败状态。
- **只加载原始网址。** Bilibili、YouTube 和普通网页都直接加载用户点下的原始 URL，不替换成播放器、阅读页或其他适配页面。
- **禁止嵌入的网站改用 Firefox 小窗。** 普通网站始终先在页内预览；只有用户明确选择“切换并记住”后，该精确站点才会复用一个 Firefox 顶层小窗，从而保留登录、插件、Cookie 和网站要求的顶层环境。
- **权限。** 只访问 HTTP(S) 页面；不请求 `file://`、摄像头、麦克风或下载权限。DNS 公网校验、响应头兼容和历史写入均由安装清单明确声明。
- **不收集数据。** 设置和预览会话留在浏览器内；不包含遥测、广告或远程分析服务，清单明确声明不收集数据。

## 功能

- 长按、拖拽、修饰键点击和键盘操作触发链接预览。
- 可移动、缩放、固定和关闭的独立预览窗口。
- 多预览并存，每个窗口维护独立的历史记录和控制状态。
- 在预览、新标签页、侧边栏和 Firefox 完整网页小窗之间切换。
- 预览内链接、表单、下载和脚本弹窗都有明确去向，不再出现“点了没反应”。
- 提供预览内后退、前进、停止、刷新；后退/前进按各自的历史记录直接导航，并正确区分单页应用的 `pushState` 与 `replaceState`。
- 保留重定向、单页应用导航和 URL fragment，地址可直接复制。
- 网站不允许 iframe 嵌入、要求顶层环境或返回访问挑战时，提供重试、仅本次完整网页小窗、切换并记住站点和新标签页。
- 默认把真正访问过的预览写入 Firefox 历史；用户可在设置页关闭记录，隐私窗口始终不写入。
- 明暗主题、减少动态效果、键盘焦点和高对比度支持。
- 加载壳、控制栏和原网页并行启动；页面提交后即可渐进显示，不再等待固定延迟。
- 点击小窗口外部会完整吞掉这一轮指针事件，关闭窗口时不会误触后方链接或按钮。

## 安全结构

页面中的 UI 位于 closed Shadow DOM 内。原网页 iframe 与本地 `preview/preview.html` 控制栏是宿主页面的同级子框架：网站看到的祖先仍是原站页面，因此同站的 `SAMEORIGIN` 和 `frame-ancestors 'self'` 可以正常工作，而控制栏仍由 `moz-extension` 来源隔离。目标框架先用独立、短时且只能使用一次的文档能力完成绑定，后台随后结合标签页、完整祖先 document ID 链与 frame ID 跟踪同一个预览浏览上下文；普通网页 iframe 不能冒充预览目标，目标树的子页面也不能覆盖根页面的地址、历史或控制通道。

**后代框架的嵌入规则。** 嵌入放宽是为 GlassPeek 自己嵌入的直接目标准备的；目标页面自行创建的后代 iframe（第三方小部件、播放器、广告位等）不应因为被预览而获得它在真实顶层窗口里得不到的嵌入许可，否则任何带 `DENY` 的第三方页面都会在预览里失去点击劫持防护。因此后台对后代响应改用“把直接目标视为顶层页面”的模拟判断：取 Firefox 报告并已校验的祖先链，去掉宿主页面这一层（控制栏是同级框架，本来就不在祖先链里），再按浏览器自己的规则评估响应头——`X-Frame-Options: DENY`、`ALLOW-FROM`、无效或重复的值以及 `frame-ancestors 'none'` 一律原样保留；`X-Frame-Options: SAMEORIGIN` 只有在响应来源与直接目标及中间所有祖先来源都相同时才移除；`frame-ancestors <来源列表>` 按 CSP3 的 `'self'`、scheme-source、host-source（含 `*.` 通配、端口与路径）逐条匹配模拟祖先链，每个祖先都命中才移除该策略里的这条指令，否则整条策略不动。祖先链里出现无法判断来源的文档（非 HTTP(S)、`blob:` 等）时，对该响应不做任何放宽。换句话说，后代框架能显示的内容恰好等于“用户直接在标签页打开直接目标”时能显示的内容；只有宿主页面这一层额外祖先被抹平。

扩展页 CSP 只允许本地脚本和样式，不含 `unsafe-eval` 或远程代码。目标 URL 必须是合法的 `http:` 或 `https:` 地址；凭据型 URL、浏览器内部协议和扩展协议会被拒绝。首次授权和每次预览框架导航都会检查 DNS 结果；直接连接还会在响应头处理前核对 Firefox 报告的实际服务器 IP，代理 HTTPS 则使用 Firefox 已接受的 TLS 来源状态完成核验。私网、环回和特殊用途地址不会获得嵌入兼容处理；唯一例外是严格识别的 Mihomo/Clash TUN fake-IP 传输池，它只被视为代理传输句柄，不能把普通私网地址变成可预览目标。

兼容处理可解决大多数仅由 `X-Frame-Options` 或 CSP `frame-ancestors` 造成的嵌入失败。某些网站仍可能因为以下原因不能在页内完整工作：

- 登录、第三方 Cookie、OAuth 或人机验证要求顶层浏览上下文；
- 网站依赖弹窗、下载、摄像头、麦克风或其他被 sandbox 禁止的能力。

所有普通公共 HTTP(S) 地址都会以原始 URL 在预览浮层中尝试加载。失败后会停留在提示页；用户可仅本次打开完整网页小窗，也可记住精确站点。记住后，该站点会跳过 iframe 并复用同一个 Firefox 顶层小窗，直到用户在设置页移除。允许在子框架运行的 Firefox 扩展通常可继续注入页内预览；只支持顶层标签页的扩展可在完整网页小窗中正常工作。

GlassPeek 自己的后退/前进按钮使用每个预览窗口的独立历史记录。Firefox 的浏览器工具栏历史仍采用页面与 iframe 共享的 joint session history；网站脚本、表单或单页应用主动写入的原生历史项可能被浏览器工具栏“后退”遍历。为保留原网页行为，GlassPeek 不篡改网站的 `history.pushState()` / `replaceState()` 语义。侧栏的嵌入兼容与地址核验只作用于侧栏直接打开的网页；该网页自行创建的更深层 iframe 保持 Firefox 的普通嵌入规则（侧栏文档本身就是顶层上下文，无需模拟）。页内预览的后代 iframe 则按上文“后代框架的嵌入规则”以直接目标为顶层做模拟判断。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `storage` | 保存用户设置和站点规则 |
| `tabs` | 在标签页中打开页面并读取必要的标签页上下文 |
| `webNavigation` | 依据 document ID 跟踪预览导航、完成与失败状态 |
| `webRequest`、`webRequestBlocking` | 只为当前已验证的预览框架树调整阻止 iframe 的响应头 |
| `dns` | 在授予预览和框架导航前解析目标主机，拒绝指向本机、私网或特殊用途地址的目标 |
| `history` | 把实际预览过的地址写入 Firefox 历史；不读取历史，隐私窗口不写入 |
| `clipboardWrite` | 由用户操作复制预览链接 |
| `http://*/*`、`https://*/*` | 在普通网页上发现链接并加载用户请求的预览 |

历史记录默认开启，用户可随时在设置页关闭。关闭后 GlassPeek 不调用历史 API；隐私窗口无论设置如何都不记录。

通过 HTTP、HTTPS、SOCKS 或 Mihomo/Clash TUN fake-IP 连接时，Firefox 报告的连接地址可能只是代理端点或合成地址，而不是目标网站。GlassPeek 不把代理端点本身当成公网证明：HTTPS 需要 Firefox 已接受的 TLS 来源状态，直接连接需要可核对的公网服务器 IP；Mihomo/Clash 仅识别默认的 `198.18.0.0/16` 与 `fdfe:dcba:9876::/64` 两类专用 fake-IP 传输句柄，并要求实际连接地址与该域名刚得到的 DNS 记录精确一致。无法验证来源的受保护响应不会被放宽，并会提示改用完整网页小窗。

交互窗口使用 Firefox 的基础 `windows` API；该 API 在 Firefox 153 中不对应可声明的 `windows` 清单权限，因此清单不会请求这个无效权限。

## 开发与验证

临时开发载入：

1. 打开 `about:debugging#/runtime/this-firefox`。
2. 选择“临时载入附加组件”。
3. 选择本目录中的 `manifest.json`。

运行静态回归、清单安全测试和 Mozilla linter：

```powershell
node tests/manifest.test.js
node tests/static.test.js
npx web-ext lint --source-dir . --ignore-files tests web-ext-artifacts backups output .playwright-cli
```

完整验收使用一次性的 Firefox 配置，不会改动日常浏览器：

```powershell
node tests/run-isolated-smoke.js --xpi=output/release-2.4.0/glasspeek-2.4.0-unsigned.zip --live-sites --headless
```

临时载入只用于开发，Firefox 重启后会移除。日常使用必须安装 Mozilla 签名的 XPI。

## 签名与安装

Firefox 稳定版只能长期安装经 Mozilla 签名的扩展。公开版本通过 AMO 的 Listed 渠道发布；自己打包测试时可以走 Unlisted（自行分发）渠道，签名效力相同，只是不出现在商店搜索里。

网页方式：

1. 登录 [AMO Developer Hub](https://addons.mozilla.org/developers/)。
2. 提交新扩展，公开发布选 Listed，自用选自行分发（Unlisted）。
3. 上传扩展包，通过验证后下载 Mozilla 签名的 `.xpi`。
4. 在 Firefox 打开 `about:addons`，从齿轮菜单选择“从文件安装附加组件”，再选择签名 XPI。

也可使用 AMO API 凭据签名。凭据只应放在当前终端的临时环境变量中，绝不能写入仓库：

```powershell
$env:WEB_EXT_API_KEY = "<AMO JWT issuer>"
$env:WEB_EXT_API_SECRET = "<AMO JWT secret>"
npx web-ext sign --source-dir . --artifacts-dir web-ext-artifacts --channel=unlisted   # 公开发布改为 --channel=listed
Remove-Item Env:WEB_EXT_API_KEY, Env:WEB_EXT_API_SECRET
```

本项目没有配置自托管 `update_url`。后续版本需要沿用相同扩展 ID、提高版本号、重新签名，然后从文件覆盖安装；这样会保留扩展身份和设置。

## 许可证

[MIT](LICENSE)
