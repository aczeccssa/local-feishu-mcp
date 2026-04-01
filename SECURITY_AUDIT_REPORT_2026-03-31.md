# local-feishu-mcp 安全审查报告

> 说明: 本报告记录的是 2026-03-31 审查时的初始风险状态。
> 2026-04-01 已实施一轮修复，当前代码基线已完成依赖升级、HTTP 安全加固、日志脱敏、`.env` 取消跟踪，且 `pnpm audit --registry=https://registry.npmjs.org --json` 结果为 0 漏洞。该报告可作为修复前基线留档使用。

- 审查日期: 2026-03-31
- 审查对象: `local-feishu-mcp`
- 审查范围:
  - 第三方依赖漏洞扫描
  - 源代码安全缺陷检测
  - 身份验证与授权机制评估
  - 敏感信息与日志泄露检查
  - 数据加密与传输安全检查
  - 输入验证与输出编码审查

## 1. 执行摘要

本次审查发现 4 个高风险源码/配置问题和 1 组高优先级依赖风险，整体安全状态为`高风险`。

最严重的问题不是传统 SQL 注入或 XSS，而是以下组合风险:

1. 真实飞书凭据已写入并被 Git 跟踪，且仓库已配置远程 `origin`。
2. HTTP/SSE MCP 服务默认无鉴权，并且 `app.listen(port)` 未限制监听地址。
3. 飞书访问令牌、请求头和响应体被打印并通过 MCP 日志通道转发。
4. SSE 会话管理实现错误，只保存单个全局 transport，未按 `sessionId` 路由。
5. 直接依赖的 `@modelcontextprotocol/sdk@1.8.0` 已命中 DNS rebinding 与 ReDoS 高危公告。

如果该服务在开发机、共享网络环境或被浏览器/本地其他进程访问，攻击者可能在无凭据的情况下读取飞书空间/文档元数据、劫持 MCP 会话、获取访问令牌，或对服务实施拒绝服务攻击。

## 2. 审查方法

### 2.1 依赖审计

- `npm audit --json`
  - 未执行成功，原因: 仓库没有 `package-lock.json`，仅存在 `pnpm-lock.yaml`
- `pnpm audit --json`
  - 默认失败，原因: 本机 registry 指向 `https://registry.npmmirror.com`，其审计端点不存在
- 实际采用:
  - `pnpm audit --registry=https://registry.npmjs.org --json`
- Snyk:
  - 当前环境未安装 `snyk` 客户端，且 `SNYK_TOKEN` 缺失，因此无法得到可信的 Snyk 结果

### 2.2 源码审计

- 人工审查文件:
  - `src/server.ts`
  - `src/index.ts`
  - `src/api/feishu.ts`
  - `package.json`
  - `.env.example`
  - `.gitIgnore`
- 辅助验证:
  - `pnpm exec tsc --noEmit` 通过
  - Git 跟踪状态、远程仓库配置、提交历史检查

## 3. 风险总览

### 3.1 源码与配置风险

| 编号 | 风险等级 | 标题                                                     |
| ---- | -------- | -------------------------------------------------------- |
| C-01 | 高       | 真实凭据进入 Git 跟踪且忽略规则失效                      |
| C-02 | 高       | MCP HTTP/SSE 接口无鉴权且未限制监听地址                  |
| C-03 | 高       | 访问令牌、请求头和 API 响应被明文记录并转发              |
| C-04 | 高       | SSE 会话按单一全局 transport 处理，存在会话串线/劫持风险 |
| C-05 | 中       | 输入验证过弱，`spaceId` 原样拼接到上游 API 路径          |
| C-06 | 中       | 缺少速率限制、连接限制和最小暴露面控制                   |

### 3.2 依赖风险

`pnpm audit` 结果:

- `critical`: 1
- `high`: 9
- `moderate`: 5
- `low`: 2

其中真正影响运行时的高优先级依赖主要集中在:

- `@modelcontextprotocol/sdk@1.8.0`
- `axios@1.8.4`
- `form-data@4.0.2`（经 `axios` 引入）
- `express` 相关传递依赖（`path-to-regexp`、`body-parser`、`qs`）

另有多项 `high/moderate` 来自 `nodemon -> minimatch/picomatch/brace-expansion`，属于开发链路风险，通常不应进入生产运行时。

## 4. 详细发现

### C-01 真实凭据进入 Git 跟踪且忽略规则失效

- 风险等级: 高
- 位置:
  - `.gitIgnore:1-2`
  - Git 当前已跟踪 `.env`
  - `.env` 中存在非示例值凭据
- 证据:
  - 仓库使用的是 `.gitIgnore`，而不是 Git 默认识别的 `.gitignore`
  - `git ls-files` 显示 `.env` 已被版本控制
  - `.env` 中 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 为真实值而非示例占位符
  - `git remote -v` 显示已配置远程仓库 `origin`
  - `git log -- .env` 显示 `.env` 已进入提交历史
- 影响范围:
  - 飞书应用凭据可能已泄露给所有能访问仓库历史的人
  - 凭据一旦泄露，攻击者可直接调用飞书开放 API 获取租户级访问令牌
  - 如果远程仓库曾被推送，风险应视为已外泄，而不是“可能外泄”
- 修复建议:
  - 立即吊销并轮换 `FEISHU_APP_ID/FEISHU_APP_SECRET`
  - 立刻创建正确的 `.gitignore`，至少包含 `.env`、日志文件、构建输出
  - 将 `.env` 从 Git 索引移除，并清理历史提交中的敏感文件
  - 在 CI 中加入 secret scanning（如 gitleaks、GitHub secret scanning）

### C-02 MCP HTTP/SSE 接口无鉴权且未限制监听地址

- 风险等级: 高
- 位置:
  - `src/server.ts:189-257`
  - `src/index.ts:19-31`
- 问题说明:
  - `/mcp` 与 `/mcp-messages` 没有任何认证、授权、来源校验或 IP 访问控制
  - `app.listen(port, ...)` 未指定主机地址，默认会监听所有网络接口，而不仅是 `127.0.0.1`
- 影响范围:
  - 本机任意进程、同一局域网主机，甚至错误暴露到公网的客户端，都可能直接访问 MCP 能力
  - 该服务暴露的工具可读取飞书空间和文档列表，属于高敏感业务元数据
  - 一旦与 DNS rebinding 或本地恶意网页配合，可绕过“仅本地使用”的假设
- 攻击路径示例:
  - 未授权客户端直接访问 `GET /mcp` 建立 SSE 连接，再向 `POST /mcp-messages` 发送 JSON-RPC 消息调用工具
  - 局域网其他主机在端口开放时直接调用工具
- 修复建议:
  - 默认关闭 HTTP 模式，优先仅提供 stdio 模式
  - 若必须提供 HTTP:
    - 仅绑定 `127.0.0.1`
    - 为 `/mcp` 和 `/mcp-messages` 增加强认证，例如随机 Bearer Token
    - 增加 Host 头校验、来源校验、连接超时和速率限制
    - 在反向代理层加 TLS 和访问控制

### C-03 访问令牌、请求头和 API 响应被明文记录并转发

- 风险等级: 高
- 位置:
  - `src/api/feishu.ts:96-118`
  - `src/api/feishu.ts:127-134`
  - `src/server.ts:266-279`
- 问题说明:
  - `request()` 会打印完整 `Authorization: Bearer <token>`
  - 同时打印请求参数、请求体以及成功响应数据
  - `Logger.log` / `Logger.error` 会把日志通过 `this.server.server.sendLoggingMessage(...)` 转发给连接的 MCP 客户端
- 影响范围:
  - 飞书租户访问令牌可被日志平台、终端录屏、AI 客户端日志面板或调试输出窃取
  - API 响应里包含空间名、节点名、文档标题等业务元数据
  - 一旦客户端不可信或日志被集中采集，数据泄露面会显著扩大
- 修复建议:
  - 严禁记录访问令牌、密钥、请求头中的认证信息
  - 默认关闭调试级别响应体日志
  - 日志转发前做敏感字段脱敏
  - 使用结构化日志并明确区分审计日志与调试日志

### C-04 SSE 会话按单一全局 transport 处理，存在会话串线/劫持风险

- 风险等级: 高
- 位置:
  - `src/server.ts:26`
  - `src/server.ts:225-247`
  - `src/server.ts:180-181`
  - `node_modules/@modelcontextprotocol/sdk/README.md:227-247`
  - `node_modules/@modelcontextprotocol/sdk/dist/esm/server/sse.js:35`
  - `node_modules/@modelcontextprotocol/sdk/dist/esm/server/sse.js:107-113`
- 问题说明:
  - 当前实现只保存一个 `this.transport`
  - 新的 `/mcp` 连接会覆盖旧 transport
  - `/mcp-messages` 未读取 `sessionId`，而 SDK 的标准模式要求根据 `sessionId` 路由到各自的 transport
- 影响范围:
  - 多客户端同时连接时可能出现会话串线、消息路由错误或连接被覆盖
  - 攻击者可通过抢占新的 SSE 连接，打断正常客户端会话
  - 在无鉴权场景下，这会进一步放大未授权调用和拒绝服务风险
- 修复建议:
  - 改为 `Map<string, SSEServerTransport>` 按 `sessionId` 管理连接
  - 在 `res.close` 时清理 transport
  - `/mcp-messages` 必须校验 `req.query.sessionId`
  - 只允许与已建立会话匹配的 POST 消息进入对应 transport

### C-05 输入验证过弱，`spaceId` 原样拼接到上游 API 路径

- 风险等级: 中
- 位置:
  - `src/server.ts:100-103`
  - `src/api/feishu.ts:165-179`
- 问题说明:
  - `spaceId` 仅通过 `z.string().optional()` 做了类型检查，没有长度、字符集、格式白名单
  - 后续直接拼接到 `/wiki/v2/spaces/${spaceId}/nodes`
- 影响范围:
  - 恶意输入可导致异常路径、日志污染、上游 API 错误风暴
  - 虽然当前不会导致跨域 SSRF，但会扩大 Feishu API 调用面的可控性
- 修复建议:
  - 使用严格白名单正则校验 `spaceId`
  - 对路径片段做 `encodeURIComponent`
  - 增加长度限制和错误码归类，避免把上游异常直接暴露给客户端

### C-06 缺少速率限制、连接限制和最小暴露面控制

- 风险等级: 中
- 位置:
  - `src/server.ts:189-257`
- 问题说明:
  - 未配置速率限制、连接数限制、请求超时、空闲连接清理
  - 健康检查、主页、SSE 建连和消息接口均无访问频率控制
- 影响范围:
  - 可被低成本地或网络流量压垮
  - 与无鉴权暴露叠加后，拒绝服务门槛更低
- 修复建议:
  - 为 HTTP 路由增加速率限制与连接超时
  - 仅暴露必要路由，关闭生产环境主页
  - 为 SSE 连接增加最大并发与心跳/超时策略

## 5. 依赖漏洞审计结果

### 5.1 关键和高危依赖

| 严重级别 | 组件                        | 当前版本 | 路径                                    | 说明                                                                 | 修复建议                                        |
| -------- | --------------------------- | -------- | --------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| Critical | `form-data`                 | `4.0.2`  | `.>axios>form-data`                     | `GHSA-fjxv-7rqg-78g4` / `CVE-2025-7783`，边界随机值使用不安全随机源  | 升级到 `4.0.4+`，通常通过升级 `axios` 解决      |
| High     | `@modelcontextprotocol/sdk` | `1.8.0`  | `.>@modelcontextprotocol/sdk`           | `GHSA-8r9q-7v3j-jr4g` / `CVE-2026-0621`，ReDoS                       | 升级到 `1.25.2+`                                |
| High     | `@modelcontextprotocol/sdk` | `1.8.0`  | `.>@modelcontextprotocol/sdk`           | `GHSA-w48q-cv73-mx4w` / `CVE-2025-66414`，DNS rebinding 防护默认关闭 | 升级到 `1.24.0+`，并启用 host 校验              |
| High     | `axios`                     | `1.8.4`  | `.>axios`                               | `GHSA-4hjh-wcwx-xvwj` / `CVE-2025-58754`，`data:` URL DoS            | 升级到 `1.12.0+`                                |
| High     | `axios`                     | `1.8.4`  | `.>axios`                               | `GHSA-43fc-jf86-j433` / `CVE-2026-25639`，`__proto__` 配置触发 DoS   | 升级到 `1.13.5+`                                |
| High     | `path-to-regexp`            | `8.2.0`  | `.>express>router>path-to-regexp`       | `GHSA-j3q9-mxjg-w52f` / `CVE-2026-4926`，路由模式 ReDoS              | 升级到 `8.4.0+`，通常需等待/升级 Express 依赖链 |
| High     | `picomatch`                 | `2.3.1`  | `.>nodemon>chokidar>anymatch>picomatch` | `GHSA-c2c7-rcm5-vvqj` / `CVE-2026-33671`，开发链路 ReDoS             | 升级开发依赖，避免带入生产                      |
| High     | `minimatch`                 | `3.1.2`  | `.>nodemon>minimatch`                   | `GHSA-3ppc-4f35-3m26` / `CVE-2026-26996`，开发链路 ReDoS             | 升级开发依赖                                    |
| High     | `minimatch`                 | `3.1.2`  | `.>nodemon>minimatch`                   | `GHSA-7r86-cg39-jmmj` / `CVE-2026-27903`，开发链路 ReDoS             | 升级开发依赖                                    |
| High     | `minimatch`                 | `3.1.2`  | `.>nodemon>minimatch`                   | `GHSA-23c5-xmqv-rm74` / `CVE-2026-27904`，开发链路 ReDoS             | 升级开发依赖                                    |

### 5.2 中低危依赖

| 严重级别 | 组件              | 当前版本 | 路径                                    | 修复建议                   |
| -------- | ----------------- | -------- | --------------------------------------- | -------------------------- |
| Moderate | `body-parser`     | `2.2.0`  | `.>express>body-parser`                 | 升级到 `2.2.1+`            |
| Moderate | `qs`              | 传递依赖 | `.>express>qs`                          | 升级到 `6.14.1+ / 6.14.2+` |
| Moderate | `brace-expansion` | `1.1.11` | `.>nodemon>minimatch>brace-expansion`   | 升级到 `1.1.13+`           |
| Moderate | `picomatch`       | `2.3.1`  | `.>nodemon>chokidar>anymatch>picomatch` | 升级到 `2.3.2+`            |
| Moderate | `path-to-regexp`  | `8.2.0`  | `.>express>router>path-to-regexp`       | 升级到 `8.4.0+`            |
| Low      | `brace-expansion` | `1.1.11` | `.>nodemon>minimatch>brace-expansion`   | 升级到 `1.1.12+`           |
| Low      | `qs`              | 传递依赖 | `.>express>qs`                          | 升级到 `6.14.2+`           |

### 5.3 依赖漏洞的当前可利用性判断

- `@modelcontextprotocol/sdk`
  - 当前项目直接使用，且确实暴露 HTTP/SSE 服务
  - 与源码问题 C-02、C-04 叠加，实际风险高
- `axios` / `form-data`
  - 当前代码中请求目标域名固定为 `https://open.feishu.cn/open-apis`
  - 未发现用户可控 URL 或用户可控 axios config 直达点
  - 因此当前可利用性低于公告原始评级，但仍应尽快升级
- `path-to-regexp`
  - 当前路由都是固定字符串，未使用危险的动态路由模式
  - 当前项目直接可利用性较低，但依赖仍需升级
- `nodemon/minimatch/picomatch/brace-expansion`
  - 主要是开发时风险
  - 如果生产镜像/部署环境安装 devDependencies，则仍有暴露面

## 6. 分类审查结论

### 6.1 SQL 注入

- 结论: 未发现
- 说明:
  - 当前源码没有数据库连接、ORM、原生 SQL 查询或文件型 SQL 存储逻辑
  - `.env.example` 中虽然存在 `DB_LOCATION`，但代码未使用

### 6.2 XSS

- 结论: 未发现直接 XSS
- 说明:
  - `/` 路由返回静态 HTML，不含用户输入拼接
  - 未发现 `innerHTML`、模板注入、动态脚本拼接

### 6.3 CSRF

- 结论: 传统基于 Cookie 的 CSRF 不适用，但存在更严重的本地服务滥用风险
- 说明:
  - 服务没有会话 Cookie，也没有浏览器态登录
  - 但由于 HTTP 服务无鉴权，再叠加 MCP SDK 的 DNS rebinding 风险，恶意网页或本地恶意程序仍可能驱动该服务

### 6.4 身份验证与授权

- 结论: 存在严重缺陷
- 说明:
  - 对外暴露的 MCP 能力没有认证
  - 没有基于调用方、来源、token 或 IP 的授权控制

### 6.5 数据加密

- 结论: 传输与密钥管理存在明显不足
- 说明:
  - 访问飞书 API 使用 HTTPS，属于正向项
  - 本地服务使用明文 HTTP，无 TLS
  - 密钥以明文形式保存在 `.env`，且已进入 Git 跟踪
  - 未发现数据静态加密或密钥轮换机制

### 6.6 输入验证与输出编码

- 结论: 输入验证不足，输出编码风险较低，但日志输出严重过度
- 说明:
  - `spaceId` 校验过弱
  - HTML 输出未拼接用户输入，编码风险较低
  - 日志直接输出认证头、请求体和响应体，属于敏感数据输出问题

## 7. 高风险问题优先修复方案

### P0: 24 小时内完成

1. 凭据处置
   - 立即轮换飞书 `App ID / App Secret`
   - 评估远程仓库是否已推送；若已推送，按“凭据已泄露”处理
2. Git 清理
   - 新建正确的 `.gitignore`
   - 从 Git 索引中移除 `.env`
   - 清理仓库历史中的敏感文件
3. 停止敏感日志
   - 删除 token、请求头、响应体日志
   - 关闭向 MCP 客户端转发敏感日志
4. 立即缩小暴露面
   - 若无强制需求，停用 HTTP 模式，仅保留 stdio
   - 若必须保留 HTTP，先绑定 `127.0.0.1` 并加 Bearer Token

### P1: 3 个工作日内完成

1. 修复 SSE 会话模型
   - 改为按 `sessionId` 存储和查找 transport
   - 为每个会话独立清理资源
2. 升级直接依赖
   - `@modelcontextprotocol/sdk >= 1.25.2`
   - `axios >= 1.13.5`
   - 同步验证 `form-data >= 4.0.4`
   - 更新 `express` 及其传递依赖到无已知高危版本
3. 补齐安全中间件
   - Host 校验
   - 速率限制
   - 请求超时
   - 连接数限制

### P2: 1 到 2 周内完成

1. 输入与错误处理加固
   - 严格校验 `spaceId`
   - 统一错误码和错误屏蔽策略
2. 建立持续审计
   - CI 中加入 `pnpm audit`
   - 引入 Snyk 或等价 SCA 平台
   - 引入 secret scanning
3. 运行时安全基线
   - 生产环境不安装 devDependencies
   - 明确本地模式与生产模式的默认安全策略

## 8. 建议的修复顺序

建议按以下顺序推进:

1. 先处理凭据泄露和日志泄露
2. 再封堵未授权访问和会话管理缺陷
3. 然后升级直接运行时依赖
4. 最后处理开发链路依赖和 CI 治理

## 9. 审查限制与假设

- 未执行 Snyk 扫描，因为当前环境缺少 `snyk` 客户端和 `SNYK_TOKEN`
- 未直接访问远程 GitHub 仓库验证 `.env` 是否已被公开浏览，但本地 Git 历史已确认 `.env` 进入提交历史
- 未发现数据库、模板引擎或前端渲染逻辑，因此 SQL 注入和 XSS 的审查范围相对有限

## 10. 结论

该项目当前最主要的安全风险来自“凭据管理失控 + 无鉴权本地 HTTP 服务 + 敏感日志泄露 + 过期 MCP SDK”四者叠加，而不是单一代码缺陷。

如果只修一个问题，优先级最高的是:

1. 轮换并移除仓库中的飞书凭据
2. 停止输出和转发访问令牌
3. 关闭或加固无鉴权 HTTP/SSE 接口

在这些问题修复之前，不建议将该服务暴露给浏览器环境、共享网络或任何非完全受控的客户端。
