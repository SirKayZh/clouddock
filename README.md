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
| 删除账号 | 删除时确认，同时关闭全部标签页并清除该账号 Cookie 与缓存 |

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

## 数据位置（macOS）

- 账号列表：`~/Library/Application Support/CloudDock/accounts.json`
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
- 外部链接（window.open）交给系统默认浏览器打开，控制台内链在当前账号视图内跳转
