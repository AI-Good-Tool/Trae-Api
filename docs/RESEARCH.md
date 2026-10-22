# Trae 本机调试记录

日期：2026-10-21（Asia/Shanghai）。仅记录协议、字段和脱敏结果，不保存真实 token 或设备私钥。

## 参考项目

`/Users/dalong/Documents/codeWork/other/qoder switch/qoder-switch-app`：Tauri + Rust、原生前端，包含账号管理、积分统计、Token 统计、签到和本地网关。本项目参考功能结构，客户端协议独立分析。

## 登录态

- 路径：`~/Library/Application Support/{Trae,Trae CN}/User/globalStorage/storage.json`
- 主键：`iCubeAuthInfo://icube.cloudide`
- 设备证明：`iCubeAuthInfo://icube-dc:<deviceId>`
- 协议：6 字节头 `74 63 05 10 00 00`（十六进制）、32 字节随机种子、AES-128-CBC 密文；明文包含 SHA-512 校验及 JSON。派生盐来自当前安装版本 main.js 的 byteCrypto 常量，仅解析 JSON 数组，不执行客户端代码。
- 登录态有 token、refreshToken、expiredAt、refreshExpiredAt、userId、account；两版本机读取成功。
- Token 刷新需 `/trae/api/v3/oauth/ExchangeToken`，设备 P-256 私钥签名。签名串为 method、path、clientId、refreshToken、timestamp、nonce，以换行分隔。

## 官方用量与签到

客户端 bootConfig.ug 选择域名，地区沿用用户 storeRegion。鉴权为 `Authorization: Cloud-IDE-JWT <token>`。

| 功能 | 路径 |
| --- | --- |
| 国内支付状态 | POST /trae/api/v2/pay/ide_user_pay_status |
| 国内用量 | POST /trae/api/v2/pay/ide_user_ent_usage |
| 国际支付状态 | POST /trae/api/v1/pay/ide_user_pay_status |
| 国际用量 | POST /trae/api/v1/pay/ide_user_ent_usage |
| 国内签到状态 | POST /trae/api/v2/ug/checkin_credits/status |
| 国内签到领取 | POST /trae/api/v2/ug/checkin_credits/claim |

用量请求使用 `require_usage: true, req_source: 1`。国内 usage_summary 给出 total_amount、consumed_amount；国际账期包使用 basic_usage_limit、basic_usage_amount。签到包含 enable、checked_in、credits 等字段；先检查状态，已签到就跳过领取，不调用抽奖接口。

## 模型反代

主要依据本机 `libai_agent.dylib` 中的路由及 main.js 的 bootConfig 路由逻辑，另外比对了开源项目的协议字段：

- https://github.com/wo5366/trae
- https://github.com/autumnsentiment/Trae2api-cn

未复制这些项目的实现代码；当前转换器独立实现。上游地址使用本机客户端 product.json，不从研究资料硬编码第三方域名。

实测原生接口：

- `POST /api/ide/v1/get_detail_param` 可查询配置；当前 chat_v3 仅返回 FastApply 类配置。
- `POST /api/agent/v3/llm_utils_chat` 的 messages.content 为内容块数组，不能直接传字符串。SSE 文本位于 output 事件中的 response 字段。
- `model=auto` 不能直接当作上游名称，默认模式应省略 model。
- 多个普通模型经 raw_chat 接口返回 4023；inline_chat 返回缺少 function config；默认 chat_v3 返回 FastApply 类输出，曾连续输出空白。网关增加超时、1MB 上限及连续空白中止。
- 账号本机 state.vscdb 的 `<userId>:AI.agent.model.model_list_map` 存有多个模型，但缓存可见不等于 raw-chat 可用，其中模型标记 use_remote_service。后续应适配 Remote/Agent 的真实模型调用链，而非用 FastApply 冒充通用聊天模型。

## 尚需继续验证

1. 浏览器 OAuth 实际回调、换码、账号入库的完整人工登录流程。
2. 客户端关闭后的账号切换、重启登录及原始存储还原。
3. 实际设备证明 Token 轮换及客户端与工具账号库间的刷新同步。
4. Remote/Agent 模型调用、工具调用及 Messages / Responses 协议。
5. SQLCipher 会话库解密和官方逐会话用量接口；目前不读取会话正文来估算 Token。

验证命令：`npm test`、`npm run inspect -- --live`。测试包含登录态完整性、账号库加密及篡改检测、公开数据脱敏、SSE 分块、输入协议约束、工作台与网关访问控制。


## 2026-10-22 Remote / Claude Code 更新

已用官方 /api/remote/v1/models 与 chat_sessions + events 打通国内 deepseek-v4.1-flash，模型配置由官方目录完整绑定，model_config 确认实际模型，finish summary 与 completed 终态确认完成。旧 raw/FastApply 路径的结论仍作为历史研究保留，不再用它驱动生产请求。Messages、客户端工具往返和最终打包应用均完成 CC GUI 实测，当前范围见 REVIEW-0.7.0.md。国际版和其他模型不在本次真实验证范围。

## 0.6.1 客户端索引读取补充

已发现客户端 renderer.log 中结构化本地会话／项目事件和 Session fetched 数据可提供真实 chat_session_id、user_id、local_project_id 及项目目录。该路径可只读建立原生会话索引，不需要手工输入会话标题或将导入副本标为客户端来源。当前本机读得国内 3 条、国际 1 条，与客户端可见标题／分组核对。仅在客户端被观察到的远端默认任务也应保留，以符合客户端显示；未观察到的其他 API 会话不混入。日志覆盖并不保证完整历史，消息正文的加密读取仍未解决。
