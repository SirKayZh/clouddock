# CloudDock — 多账号浏览器

像 Chrome 一样浏览任意网站（腾讯云、阿里云、AWS、GitHub、Google……），但**每个账号一个独立会话**（Cookie/缓存隔离）：同一个网站可以同时登录多个不同账号，各自登录一次长期保持，侧边栏点击秒级切换，无需退出重登。

## 功能

| 功能 | 说明 |
|---|---|
| 多账号独立会话 | 每个账号独立 Cookie / 存储（Chromium session partition 级隔离），登录态互不覆盖 |
| 多标签页 | **每个账号可开多个标签页**（`⌘T` 新建 / `⌘W` 关闭），同账号所有标签页共享该账号登录态 |
| 任意网站 · 网页登录 · 自动命名 | 点「添加账号」无需输入任何信息：新建独立会话并打开**起始页**（输入网址 / 搜索，或点常用站点：腾讯云、阿里云、AWS、Azure、GitHub、Google…），在网页里正常登录。账号名自动识别：腾讯云读 UIN（子账号备注主账号）→ 其它网站用登录时输入的用户名 → 兜底用站点名；双击或右键可手动改名（支持中文输入法） |
| 一键切换 | 账号：侧边栏或 `⌘1`~`⌘9`；标签页：点击 / `⌘⇧[` `⌘⇤]`，切换无页面重载 |
| 持久登录 + 会话恢复 | 会话与各账号标签页（URL/标题/活跃状态）落盘，重启 App 自动恢复 |
| 导航工具栏 | 后退 / 前进 / 刷新 / 账号首页（该账号首次打开的站点）/ 地址栏（输入网址或搜索词） |
| 侧边栏收起 | 点工具栏最左的侧边栏按钮或 `⌘B`：收起为只显示头像的窄栏（仍可点头像切换账号），状态重启后保留 |
| 清除 Cookie | 右键账号（或悬停点「•••」、或菜单栏「账号」）：清除该账号全部 Cookie / 仅清除当前网站 Cookie / 清除全部站点数据（含缓存、本地存储）；菜单栏另有「清除所有账号的 Cookie」。只影响所选账号，已保存的密码不受影响，清除前会显示条数并确认 |
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
| `⌘B` | 收起 / 展开侧边栏 |
| `⌘R` | 刷新当前标签页 |
| `⌘=` / `⌘-` / `⌘0` | 放大 / 缩小 / 重置缩放 |
| `⌘⌥I` | 开发者工具（当前标签页） |

## 使用

1. 点击侧边栏「＋ 添加账号」，在起始页输入网址或点常用站点
2. 在网页里正常登录（扫码 / 账号密码均可），账号自动命名
3. 再添加第二个账号，登录同一网站的另一个用户（或别的网站）
4. 之后侧边栏或 `⌘1`/`⌘2` 随时切换，两边同时在线

## 密码管理（行为对齐 Chrome）

- **保存**：在任意网站登录并跳转成功后，顶部出现提示条：`保存` / `暂不` / `从不保存此网站`。登录失败（页面没跳转）不会提示；改了密码会提示「更新密码」。
- **自动填充**：再次打开已保存网站的登录页，自动填入用户名/密码。同一网站有多个用户名时填最近使用的。
- **账号隔离**：密码跟随「账号」，账号 B 看不到账号 A 保存的密码；删除账号时一并清除。
- **只填同一网站**：按 origin（协议+域名+端口）精确匹配，`localhost` 与 `127.0.0.1` 视为不同网站。
- **管理**：菜单栏「密码」→ 列出当前账号已保存的密码（点击即删除）、恢复「从不保存」的网站、清除全部。主界面不占位。
- **安全**：密码用 AES-256-GCM 加密，随机主密钥存在登录钥匙串（条目名 `com.clouddock.credentials.v1`，经系统自带 `/usr/bin/security` 读写），磁盘只存密文（`credentials.json`，权限 600）。**加解密全部在独立的 utilityProcess 子进程内完成**——主密钥与明文永远不进主进程内存（Chrome helper 最小权限进程模型的移植）。不使用 Electron safeStorage，因此**不会弹钥匙串授权框**，应用更新/重新签名也不受影响。钥匙串/子进程不可用时密码功能整体禁用，绝不明文落盘；密码不会传给界面进程，也读不到网页内脚本。（旧版 v1.2~v1.5 用 safeStorage 保存的密码无法迁移，需重新保存；v1.5 的钥匙串条目 `CloudDock Credential Key` 会自动迁移到新条目名，密码无需重录。）

## 稳定性与性能（Chrome 设计移植，v1.6.0）

| 能力 | 说明 |
|---|---|
| 崩溃收集 | Chromium 内建 crashpad 落 minidump 到本地（不上传），启动时自动只保留最近 5 份 |
| 崩溃恢复横幅 | 上次崩溃/强杀后启动，顶部出现内嵌横幅「恢复上次会话 / 重新开始」，登录态不受影响；正常退出仍自动恢复 |
| 空闲预热 | 启动 15 秒后空闲时段为各账号预建隐藏渲染进程 + 预连首页（DNS+TCP+TLS，上限 4 个），侧边栏切换秒开（Chrome Aperitif 思路） |
| 自更新 | 「帮助 ▸ 检查更新…」：校验 SHA-256 → 原子切换 → 新版本启动握手，握手超时自动回滚；磁盘始终保留上一版（`CloudDock.app.previous`） |

### 更新包制作与分发

```bash
npm run package        # 除 release/CloudDock.app 外，同时产出：
#   release/CloudDock-<版本>-update.zip   更新包
#   release/update.json                   清单（version / zip / sha256）
```

把 `update.zip` 与 `update.json` 放到任意静态目录或 HTTP 服务器，应用内「检查更新…」首次使用时选择 `update.json`（可放目录，自动识别），此后记住更新源（`settings.json` 的 `updateFeed`，也支持直接填 URL）。下载后逐字节校验 SHA-256，不符立即中止；`ditto` 解包并剥离 quarantine 后原子替换，新版窗口就绪才放行退出，30 秒未握手自动回滚并弹窗告知。

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
