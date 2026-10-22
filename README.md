# Trae Switch

Trae / Trae CN 本地账号与用量工作台，支持 Windows 和 macOS。0.8.0 新增关于应用、检查更新和应用内安装更新；账号卡片提供积分包、手动签到、自动签到、反代开关和并发设置。会话管理入口按要求继续隐藏。

## 安装与运行

GitHub Actions 的 **Build desktop apps** 在推送 main 或手动运行时生成三个平台的构建产物：

| 平台 | 产物 |
| --- | --- |
| Windows x64 | Setup.exe 安装程序、便携 ZIP、SHA-256 |
| macOS Apple Silicon | arm64 DMG、SHA-256 |
| macOS Intel | x64 DMG、SHA-256 |

在仓库 Actions 页面打开对应成功运行，在 Artifacts 下载。Windows 安装程序安装至当前用户的本地应用目录，无需管理员权限；便携 ZIP 解压后运行 Trae Switch.exe。macOS 将应用拖入 Applications。桌面包自带运行环境，无需额外安装 Node.js。macOS 使用 ad-hoc 签名，未做 Apple Developer ID 公证；Windows 包未做商业证书签名。

源码运行需要 Node.js 22+（CI 使用 24）：

```sh
npm ci
npm start
# http://127.0.0.1:19827
npm run desktop
npm test
npm run format:check
```

本地打包需在目标系统执行：

```sh
npm run build:mac
# Windows 需 NSIS（makensis.exe），支持 NSIS_PATH 指定编译器位置
npm run build:windows
npm run smoke:desktop
```

## 客户端适配

- macOS：自动识别 `/Applications/Trae.app`、`/Applications/Trae CN.app` 和当前用户 Applications 下的安装。数据读取自 `~/Library/Application Support/Trae`、`Trae CN`。
- Windows：自动识别 `%LOCALAPPDATA%\Programs\Trae`、`Trae CN`、Program Files 及其 current 目录。数据读取自 `%APPDATA%\Trae`、`Trae CN`。
- 自定义安装可用 `TRAE_INTL_PATH`、`TRAE_CN_PATH` 指定 macOS 应用包或 Windows 安装目录／exe。数据目录跟随操作系统当前用户。
- 切换时先请求对应客户端正常退出；4 秒后仍运行则强制结束该安装目录内的进程，确认停止后备份最新登录文件，写入并重新启动。国内与国际版分别锁定。无法识别进程或未能停止时中止切换，不写登录态。强退可能丢失客户端未保存的编辑内容。

## 账号与用量

账号卡片显示地区、凭证状态、模型数量、可用积分／美元额度、更新时间及近期到期积分包。国内积分保留两位小数，国际美元额度保留更高精度，两地区用量分别统计。全部积分包可在弹窗查看。存在手机号时仅展示脱敏值。

每个账号提供反代开关，关闭后不再接收新网关请求，正在执行的请求继续完成。账号设置可修改备注及 1–32 的并发上限，默认 4；卡片显示当前活跃请求数与上限。优先在符合模型、地区及指定账号条件的空闲账号中调度，全部忙时返回 429，不越过用户指定的账号限制。

国内账号支持手动签到、批量签到与按账号自动签到。自动签到需保持应用运行，启动时补签，每 10 分钟检查；按北京时间判断当天，领取前查询状态，已签不重复领取。国际版没有相同的签到入口。

## 模型反代与请求记录

默认网关为 `http://127.0.0.1:19828/v1`，端口可配置；国内专用 `/cn/v1`，国际专用 `/intl/v1`。启用双区联合后，同名真实模型可跨区调度，独有模型只分配给实际支持的地区账号。支持轮询、顺序优先、随机及指定账号，每次请求仅发送给一个账号，不自动重放上游请求。

模型目录可编辑对外别名及允许地区；模型列表与响应使用别名，实际请求采用所选账号的真实配置。请求记录同时保留别名、真实模型、配置、账号地区、协议、Token、HTTP 状态及耗时。缺少上游 usage 时显示未提供，不估算 Token。

API Key 可编辑或随机生成，更新立即生效。支持 Chat Completions 和 Claude Messages，使用 Bearer Key 或 Messages 的 x-api-key。CC GUI / Claude Code 的 `ANTHROPIC_BASE_URL` 填网关根地址（不带 `/v1/messages`），模型使用最新模型目录中的名称／别名。

Messages 支持文本、system、tool_use/tool_result 与命名 SSE。工具采用文本桥接，由调用客户端执行；Remote 本轮完成后才输出标准 Messages SSE，尚非逐 Token 实时转发。Responses、图像输入及精确计数尚未接入。国内 Remote 文本与工具往返曾完成实机验证，国际版其他模型需逐一验证。

## 数据与验证范围

账号库与请求元数据位于当前用户 `~/.trae-switch/`（Windows 为用户主目录下同名文件夹），使用 AES-256-GCM 加密。macOS 文件权限为当前用户独占，Windows 依赖用户目录的 NTFS ACL。密钥和密文同处本机，不能抵御已取得当前用户权限的程序。源码和安装包不包含本机账号库、密钥或调试截图。

工作台与网关仅监听 127.0.0.1，工作台检查 Cookie、Host 与 Origin。请求记录最多保留 1,000 条运行元数据，不保存输入、输出、工具参数或认证令牌。会话功能保留历史实现和数据，但不提供界面入口；不保证读取 Trae 完整历史。

测试覆盖跨区模型与别名路由、账号并发及禁用、登录态完整性、切换备份顺序、Windows 进程隔离、签到去重、请求记录脱敏和访问控制。CI 在三个原生系统环境运行测试、格式检查、打包及打包后桌面启动测试。Windows 的真实 Trae 登录／换号仍需在安装了客户端的 Windows 机器验证。

本次审查见 [REVIEW-0.7.0](docs/REVIEW-0.7.0.md)，协议研究见 [RESEARCH](docs/RESEARCH.md)。

## 关于应用与在线更新（0.8.0）

侧栏底部和桌面应用菜单提供「关于应用」「检查更新」。关于页显示实际应用版本、作者主页、源码、赞助说明和问题反馈入口。打包桌面版启动 3 秒后检查稳定版，也可手动检查；不会自动下载或自动安装。

更新源固定为本仓库 GitHub Releases，严格选择当前系统和架构的安装包。支持下载进度、取消与重试；下载后校验发布记录的 SHA-256（或同名校验文件），安装前再次验证。macOS 从只读 DMG 校验应用标识、版本、架构及签名，退出后替换并重启；Windows 等待退出，备份旧应用、运行 NSIS 安装程序，再启动并确认新版本。账号库不参与替换。更新日志及恢复副本保留在更新工作目录，失败时不删除备份。

macOS 需将应用安装到可写目录，不能直接从 DMG 或 App Translocation 中更新。Windows 便携版需放在独立目录。浏览器／源码开发模式可以检查版本，安装功能仅供打包桌面版使用。检查失败和仓库尚无 Release 会分别显示对应状态，不会误报「已是最新」。

发布更新：推送与 package.json 版本一致的 `vX.Y.Z` 标签，或在 Build desktop apps 手动运行时勾选 publish。全部平台测试及打包成功后，才上传安装包和校验文件到 Releases；默认 main 推送仍仅构建 Artifacts，不发布，也不覆盖已有 Release。
