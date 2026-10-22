# 0.8.0 关于页面与在线更新审查

参考本机 codex-account-switcher 的 AboutPanel.vue、app_update.rs 与 macOS 安装助手，按本项目 Electron 架构独立实现。

## 实现

- 关于页和应用菜单显示当前版本、作者、仓库、赞助说明、反馈和更新入口；版本统一读取 package.json。
- 打包版启动检查及手动检查仅访问本仓库 GitHub 稳定 Releases。分别区分无发布、已最新、新版本、网络失败、下载中、已校验、取消和安装中。
- 明确匹配 macOS arm64 / x64 或 Windows x64 Setup.exe，不混用便携 ZIP。下载固定仓库地址，仅允许 GitHub 官方资源 CDN 重定向；限制文件大小与时间，SHA-256 验证后才能安装，安装前再次重验且拒绝更新目录外文件。
- 安装操作仅由受限 Electron preload / IPC 暴露给本窗口主框架，浏览器 HTTP 接口只能查询版本。下载和安装均由用户点击确认，任务状态避免重复执行。
- macOS 只读挂载 DMG，验证应用标识、版本、Mach-O 架构、签名与可执行文件路径；同卷 staging，等待旧进程退出后替换，保留旧应用。Windows 等待退出并备份后运行 NSIS，再启动新版。启动确认失败时保留恢复副本与错误日志，下次打开显示故障工作目录。
- 独立后台连接模式禁用原位安装，避免更新重启后仍被旧后台占用端口。停止后台失败时终止待命更新助手，不延后意外安装。
- 新版增加 tag / 手动 publish 发布作业；全部平台构建通过后验证校验文件并创建 Release，不覆盖既有更新资源。此变更没有执行发布。

## 验证

- 44 项自动测试通过，覆盖版本比较、架构选择、取消、并发检查合并、校验失败、外部重定向、超量下载、安装前篡改与路径边界。
- 隔离账号库实测关于页、导航与 GitHub 在线检查：当前仓库没有正式 Release，明确显示未发布，没有误报最新版。
- 本机 macOS 打包通过签名与 DMG 校验，打包后启动测试验证 preload 更新桥接、下载进度事件、取消／安装按钮状态和会话入口隐藏。
- 使用真实 0.8.0 DMG 与隔离复制的 0.7.0 应用，验证更新包元数据、架构、签名、同卷 staging 和独立助手就绪；随后停止测试助手，确认旧副本保持 0.7.0。没有替换用户当前安装的应用。

Windows 更新助手及真正的下载后跨版本重启尚未在本轮实机验证。仓库需先发布正式 Release，客户端才能取得线上安装包。macOS ad-hoc 签名与 Windows 未签名策略沿用现有构建，并非 Electron Squirrel 更新通道。

审查依据：[Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)、[GitHub Releases API](https://docs.github.com/en/rest/releases/releases)。
