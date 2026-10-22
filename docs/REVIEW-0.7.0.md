# 0.7.0 代码审查与验证

## 范围

审查账号卡片、账号反代开关与并发控制、Windows/macOS 客户端发现及启停、OAuth 浏览器启动、桌面打包和 GitHub Actions。兼顾当前工作区已有 Messages、Remote、隐藏会话和自动退出切换改动。

## 已修复的问题

- 原有安装路径、数据路径、进程枚举和应用／浏览器启动只适用于 macOS。增加系统适配层，Windows 使用 APPDATA / LOCALAPPDATA、CIM 进程路径、CloseMainWindow 与按 PID 的 taskkill。无 shell 拼接用户参数，不按宽泛进程名强杀。
- 自定义 Windows exe 不能被错误复用于另一候选安装目录；增加回归测试，校验 product.json 的国内／国际身份。
- 账号卡片开关接入真实路由过滤与持久化。同步预留请求并发，成功、错误和取消均经 finally 释放；全部可用账号忙时 429，不回退到不支持模型的账号。
- 打包只复制 server、ui 和桌面入口，避免携带测试、研究材料、调试截图和本机账号库。Windows 生成多尺寸 ICO、NSIS 用户安装包和便携 ZIP。
- macOS 打包调整 staging 顺序，图标生成后再复制资源。OAuth 浏览器打开失败时清理等待定时器。
- 打包后测试以隔离数据目录、临时监听端口启动应用，验证界面加载及会话入口保持隐藏，不触碰真实账号。

## 验证

- 本机 39 项自动测试全部通过；新增 Windows 路径／版本发现、进程路径边界、强退隔离、手机号脱敏及跨区并发调度测试。
- 在隔离账号库的本地工作台检查卡片布局、地区区分和积分包明细；真实账号库未改动。
- 本机 Apple Silicon 包完成 codesign 深度严格验证、DMG 校验与打包后桌面启动测试。
- GitHub Actions 配置 Windows x64、macOS arm64、macOS x64 原生构建；每个平台执行相同测试和打包后启动检查。具体执行结论以本提交对应的 Actions 运行结果为准。

审查后未发现阻断发布的问题。Windows CI 的空账号启动与模拟路径测试不等价于真实客户端换号验证；未在 Windows 真实登录态上执行切换。macOS 为 ad-hoc 签名，Windows 为未签名包。
