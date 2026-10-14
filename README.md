# CloudDock — 腾讯云多账号工作台

像 Chrome 一样浏览腾讯云控制台，但**每个账号一个独立会话**（Cookie/缓存隔离），各自登录一次长期保持，侧边栏点击秒级切换，无需退出重登。

## 功能

| 功能 | 说明 |
|---|---|
| 多账号独立会话 | 每个账号独立 Cookie / 存储（Chromium session partition 级隔离），登录态互不覆盖 |
| 多标签页 | **每个账号可开多个标签页**（`⌘T` 新建 / `⌘W` 关闭），同账号所有标签页共享该账号登录态 |
| 一键切换 | 账号：侧边栏或 `⌘1`~`⌘9`；标签页：点击 / `⌘⇧[` `⌘⇤]`，切换无页面重载 |
| 持久登录 + 会话恢复 | 会话与各账号标签页（URL/标题/活跃状态）落盘，重启 App 自动恢复 |
| 导航工具栏 | 后退 / 前进 / 刷新 / 回控制台首页 / 地址栏 |
| 缩放 / DevTools | `⌘±0` 缩放，`⌘⌥I` 打开当前标签页的开发者工具 |
| 记住密码（同 Chrome） | 任意网站登录成功后顶部询问「保存密码？」，之后打开该网站登录页自动填充；详见下方「密码管理」 |
| 删除账号 | 删除时确认，同时关闭全部标签页并清除该账号 Cookie、缓存与已保存密码 |

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `⌘1` ~ `⌘9` | 切换到第 N 个账号 |
| `⌘T` / `⌘W` | 新建 / 关闭标签页（当前账号内） |
| `⌘⇧[` / `⌘⇧]` | 上一个 / 下一个标签页 |
| `⌘[` / `⌘]` | 后退 / 前进 |
| `⌘R` | 刷新当前标签页 |
| `⌘=` / `⌘-` / `⌘0` | 放大 / 缩小 / 重置缩放 |
| `⌘⌥I` | 开发者工具（当前标签页） |

## 使用

1. 点击侧边栏「＋ 添加账号」，输入名称（如：生产环境 / 测试号）
2. 在打开的页面中正常登录腾讯云（微信扫码 / 账号密码均可）
3. 再添加第二个账号，登录另一个账号
4. 之后侧边栏或 `⌘1`/`⌘2` 随时切换，两边同时在线

## 密码管理（行为对齐 Chrome）

- **保存**：在任意网站登录并跳转成功后，顶部出现提示条：`保存` / `暂不` / `从不保存此网站`。登录失败（页面没跳转）不会提示；改了密码会提示「更新密码」。
- **自动填充**：再次打开已保存网站的登录页，自动填入用户名/密码。同一网站有多个用户名时填最近使用的。
- **账号隔离**：密码跟随「账号」，账号 B 看不到账号 A 保存的密码；删除账号时一并清除。
- **只填同一网站**：按 origin（协议+域名+端口）精确匹配，`localhost` 与 `127.0.0.1` 视为不同网站。
- **管理**：菜单栏「密码」→ 列出当前账号已保存的密码（点击即删除）、恢复「从不保存」的网站、清除全部。主界面不占位。
- **安全**：密码用系统钥匙串加密（macOS Keychain，首次使用系统可能弹出授权），磁盘只存密文（`credentials.json`，权限 600）；**首次保存时 macOS 会弹出钥匙串授权框，请点「始终允许」**（点了「拒绝」则密码功能静默关闭；本地重新打包后签名变化，可能需再授权一次）。加密不可用时功能自动关闭，绝不明文落盘；密码不会传给界面进程，也读不到网页内脚本。

## 数据位置（macOS）

- 账号列表：`~/Library/Application Support/CloudDock/accounts.json`
- 已保存密码（密文）：`~/Library/Application Support/CloudDock/credentials.json`
- 各账号会话数据：`~/Library/Application Support/CloudDock/Partitions/clouddock-<id>/`
- 彻底重置：退出 App 后删除上述 `CloudDock` 目录

## 开发

```bash
npm install          # 安装依赖（Node >= 22.12：electron install.js 需要 require(ESM)）
npm run typecheck    # TS 类型检查（零错误）
npm run build        # 编译 src/ -> dist/
npm start            # 开发运行
npm run package      # 打包 macOS arm64 .app 到 release/（手动组装，绕过安全策略对 electron-packager 的拦截）
```

打包脚本：`scripts/package.sh`（临时目录组装 + ad-hoc 签名，输出 `release/CloudDock.app`）。
安装：`cp -R release/CloudDock.app ~/Applications/ && open ~/Applications/CloudDock.app`

测试用隔离数据目录：`CLOUDDOCK_DATA_DIR=/tmp/clouddock-test npm start`

## 原理

- 主窗口加载本地 UI（侧边栏 + 工具栏），每个账号页面是一个 `WebContentsView`
- 每个账号使用 `session.fromPartition('persist:clouddock-<id>')`，获得独立的 Cookie jar / 缓存 / 存储
- 已打开账号的 View 常驻（隐藏），切换 = 显示/隐藏，不销毁会话
- `target=_blank` / `window.open` 在**同一账号内**新开标签页（共享登录态），不会丢到系统浏览器
- 每个标签页（含 iframe）注入 `pagePreload`（隔离世界 + sandbox）：捕获登录表单、自动填充；与主进程通过 IPC 通信，主进程校验发送方
