# DevOps 工具集 Tauri

现有 Electron 项目的 Tauri 2 实现，主要面向 Windows 10/11。复用原生 HTML/CSS、分组与标签交互、各站点自动登录脚本；以 Rust 命令和系统 WebView2 替换 Electron 主进程与 `<webview>`。无需另启 Web 开发服务器，也不依赖原项目目录运行。

## 运行

可直接运行 [免安装程序 0.1.1](artifacts/DevOpsTools-Tauri_0.1.1.exe)（约 9.4 MiB），或使用 [Windows x64 安装包](artifacts/DevOpsTools-Tauri_0.1.1_x64-setup.exe)（约 2.1 MiB）。Windows 需安装 Microsoft Edge WebView2 Evergreen Runtime。安装包已生成，未执行系统安装。

源码开发需要 Rust/MSVC 工具链、Windows SDK 和 Tauri CLI；前端为静态资源，没有 npm 依赖：

```powershell
# 在项目根目录执行；未安装 CLI 时先安装
cargo install tauri-cli --version '^2' --locked
cargo tauri dev

# 生成 Windows 安装包
cargo tauri build

# 验证
node --test --test-isolation=none tests/*.test.cjs
cargo test --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
cargo build --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
node tests/desktop-smoke.cjs
```

也可用 `npm run dev`、`npm run build`、`npm test`。开发构建关闭调试符号，避免本机 MSVC 调试记录错误。当前验证工具链为 Rust 1.91.1、MSVC 14.44、Node.js 24；烟雾测试使用 Node.js 自带 WebSocket。

## 配置与数据

继续只读加载现有配置 `%USERPROFILE%\.my_devops\devops_config.json`。配置对象、裸分组数组、`default_expand`、显式 `type`、`first_open_url`、`optsecret` / `otpsecret`、`loginPath` 字段兼容原实现。类型路由以实际 Electron 代码为准：未写 `type` 的站点走通用登录探测，不根据分组自动改为 Superset。

可从 `devops_config.example.json` 手动创建配置。修改配置后退出重开；配置错误页的“重启应用”会真正重启进程并重新读取配置。

Tauri 状态、日志与浏览器数据独立保存在 `%USERPROFILE%\.my_devops\tauri`：

| 位置 | 用途 |
| --- | --- |
| `devops_state.json` | 分组展开、标签顺序、焦点标签、最后 URL、克隆源引用与分组配色 |
| `webview-profile` | 所有站点共享的 WebView2 Cookie / LocalStorage 等数据 |
| `shell-profile` | 本地宿主界面的浏览器数据，与站点隔离 |
| `logs/view-*/requests.log` | 每次打开标签独立产生的网络元数据日志 |

不写入 Electron 原有状态、Cookie 或业务配置，不自动搬迁 Chromium 会话；首次使用需要重新登录。无过期时间的本站会话 Cookie 每 3 秒检查并延长为 30 天，服务端已指定的有效期保留；刚完成登录立即强制结束进程可能早于检查。克隆状态只保存 `sourceId` 等展示字段，不落盘账号、密码或 TOTP 密钥。已有源配置被删除的克隆仅恢复 URL。

可用环境变量隔离测试：

```powershell
$env:DEVOPS_CONFIG_PATH = 'D:\test\devops_config.json'
$env:DEVOPS_TAURI_DATA_DIR = 'D:\test\tauri-data'
cargo tauri dev
```

## 功能与差异

- 支持分组展开/收起、点击站点懒加载、后台并行登录、多行标签、拖动排序、克隆、关闭左右/其他/全部标签、刷新及复制链接。
- 保留 Superset、Grafana、RedisInsight、YApi、Bytebase、Jenkins、全有后台 TOTP 及通用表单策略。TOTP 在 Rust 中按 RFC 6238（30 秒、HMAC-SHA1、6 位）生成。
- Windows Basic Auth 仅对配置同源站点自动应答；认证失败回到原生对话框并给出提示。Bytebase 同源弹窗在当前标签打开，其余使用共享浏览器环境的原生子窗口。
- 保存并恢复已打开标签、克隆、顺序、焦点与最后访问 URL；切换页面不重新创建 WebView。
- F12 / Ctrl+Shift+I 打开对应站点的 WebView2 DevTools，页面使用 WebView2 原生右键菜单。Electron 的 `devtools_mode` 停靠模式、统一检查元素菜单和 Cookie 调试接口没有一比一移植。
- 标签和侧栏右键菜单使用 Tauri 原生菜单，菜单打开/取消/选择均保持站点页面显示。错误提示在标签栏下方占据独立布局区域，不会隐藏整个 WebView；侧栏折叠、窗口尺寸与标签换行会同步更新原生页面边界。
- 网络日志使用 WebView2 CDP 记录 XHR / Fetch 请求、响应状态、完成/失败及耗时。始终移除 URL 用户信息、查询参数和 fragment，不记录 headers、Cookie 和请求体。请求完成后异步读取响应体，写入独立的 `responseBody` 记录（`base64:` 前缀表示二进制响应），默认最多 1024 字节、超出追加 `...[truncated]`，可用 `max_log_response_size` 调整；超过上限 64 倍（且不小于 1 MiB）的响应对应记录 `skipped` 而不取回正文，避免大响应拖慢页面。保留 `max_log_history`（默认 7 天），清理只作用于 Tauri 自己的日志。Electron 的完整请求载荷、`desensitization` 开关和 Worker 队列参数不沿用。
- IPC 只接受本地宿主 WebView，远程页面没有本机命令权限。自动登录脚本在执行时再次核验配置同源，跨域 SSO 页面可浏览但不会填入配置凭据。

## 验证范围

`tests/frontend.test.cjs` 覆盖桥接契约、状态写入顺序、创建/关闭竞态、菜单显隐、配置错误与恢复快照。

`tests/desktop-smoke.cjs` 启动独立本地 HTTP 假站点和真实 Windows 程序，通过 WebView2 调试协议验证自动登录、Basic Auth、SPA URL、标签/克隆、布局、权限拒绝、失败提示、脱敏日志、状态与 Cookie 重启恢复和无效配置。它只在启动的测试进程启用本地调试端口，不连接实际业务服务；证据保存在 `tests/.smoke-*`。

真实内网站点的特定 DOM、SSO、代理认证、下载和原生快捷键的人工交互仍需在实际环境验收。Tauri 多 WebView 使用 `unstable` API，依赖固定在 Tauri 2.12 系列并提供 Cargo.lock；本次交付不声称已验证 macOS/Linux。
