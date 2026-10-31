# 慢速链路与反复重连

[English](SLOW_CONNECTIONS.en.md)

远程页面能打开、`/mobile-access/health` 返回正常，仍可能出现“重连中”、模型或工作区迟迟不显示。HTTP 可达只说明请求能通过；DSH 的实时数据还需要 WebSocket 连接完成初始化并保持在线。

先按实际通道排查，不要把所有等待都归因于 DSH 心跳。[Cloudflare 快速隧道](CLOUDFLARE_TUNNEL.md#快速隧道的功能限制)不支持 SSE，可能缺少完成提醒或在线撤销提示；[自备反向代理](SELF_HOSTED_ORIGIN.md#状态与手机验证)的「后端已监听」只说明私有 HTTP 端口启动；[托管 Caddy](CADDY_MANAGED.md#适用条件)需要腾讯云 DNSPod 验证和真正的公网 HTTPS 入站，DNS-01 不能打通 CGNAT。分别检查入口、证书、认证、WebSocket 与通知流，避免只增大超时掩盖前一层故障。

## 先判断重连发生在哪一步

先记录 DSH、DSH Mobile 插件和 Android App 的版本，再在电脑端 **移动访问 → 诊断** 检查当前通道；查看 DSH 启动日志和浏览器开发者工具的 Network → WS，按问题涉及的组件更新。插件与 App 独立发版，版本号不必相同。分享日志时去掉 Token、Cookie 和完整配对地址。

- **WebSocket 没有连接成功**：检查请求是否获得 `101 Switching Protocols`，并留意 `401`、`403`、`404`、`502` 等错误。认证、Host/Origin、反向代理升级支持、连接路径或版本差异都可能造成这种情况。调整心跳不能解决这些问题；第三方插件被拦截的路径可在连接诊断中按需允许，不必把 DSH 内置路径全部重新添加。
- **已获得 101，但连接反复关闭**：记录关闭间隔，并对比同一页面、同一会话的局域网与远程访问。如果只在远程打开长会话时频繁断开，同时下载长时间占满链路，才进一步检查下面的心跳和初始化等待时间。浏览器显示 `1006` 表示连接异常结束，本身不能确定是哪一层断开。
- **初始化等待超时**：若控制台出现 `connection generation was not ready within 15000ms`，说明该次实时连接没有在等待期限内完成初始化。除了慢速传输，还要排查服务端错误、代理阻断及未完成的数据订阅。

[#126](https://github.com/saya-ch/dsh-mobile/issues/126) 和 [#146](https://github.com/saya-ch/dsh-mobile/issues/146) 都报告过“HTTP 正常但实时连接重连”，它们不能仅凭界面文案判定为同一个原因。

### HTTP 拒绝诊断（插件 0.6.11 起）

插件 0.6.11 起会在插件日志（`$DSH_HOME/mobile-access/logs/dsh-mobile.log`）记录有限的 `auth failure` HTTP 诊断：区分授权与 CSRF 拒绝，包含状态、方法、安全路径或路径类别、相关 Cookie／请求头是否存在及计数、规范化 Origin、受支持的 fetch-site 值，以及有授权时设备标识的前 8 位，不记录令牌、Cookie 值、查询参数或任意原始路径。每个网关的两类诊断分别限频，首条立即记录，30 秒窗口内同类拒绝聚合；`suppressed` 表示此前被抑制的同类记录数量，不是全部请求数，也不限定于当前路径。它帮助排查凭据未携带或 CSRF 校验失败，不会自动修复 401／403。没有日志也不代表认证成功：更早的 Host／Origin 拒绝、WebSocket 升级和原生配对／续期不在这两处记录范围内。分享前仍应检查日志。

### 内部认证交换诊断（插件 0.6.15 起）

`upstream auth` 单独记录网关向本机 DSH 交换内部认证 Cookie 的结果，不是手机请求的 `auth failure`。每条只包含该网关内的交换序号 `sequence`、阶段 `stage`、固定结果 `outcome`、耗时 `durationMs`，以及收到响应头后才有的上游 HTTP `status`；这个状态不是手机最终收到的状态。`accepted` 表示严格通过 303、Cookie 和有效期检查；其他结果区分目标配置无效、状态不符、Cookie 无效、超时或传输失败。不记录内部启动地址、Token、Cookie 名称或值、响应正文及原始错误。

成功与失败分别最多每 30 秒记录一条，首条立即记录，`suppressed` 计入此前同类被抑制的交换。并发请求共用一次交换时只记录一次，使用缓存 Cookie 时不新增记录；序号仅在同一个网关实例内关联，不是设备标识。没有记录不能证明该次请求认证或页面启动成功，也不能用这类日志判断会话数据是否损坏。

## HTTP 400、408 与 431 的区别（插件 0.6.13 起）

插件 0.6.13 起把请求接收超时区分为 `408 request_timeout`，请求头过大区分为 `431 headers_too_large`；其他非法 HTTP 请求仍为 `400 bad_request`。旧版可能把这几类情况都返回成 400 和相同的短 JSON，因此状态码与“24 字节”不足以定位原因。

`http failure` 日志按网关区分 `parser`、`target`、`upstream` 三类：分别表示 HTTP 解析／接收失败、非法请求目标、已认证的 `POST /api/session/prompt` 被上游拒绝。每类首条立即记录，后续 30 秒内聚合，下一条的 `suppressed` 是此前被抑制的同类数量。日志不保留原始报错、请求正文、原始包、Cookie、Token、查询参数或任意 URL；不记录某条也不能证明它成功。

`slow api` 日志采样已认证并转发、耗时至少 3 秒的 `/api/` 请求：固定方法、`/api/session` 等固定路由类别（未知类别归为 `/api/other`）、状态和 `durationMs`。耗时从进入上游代理转发算到响应关闭，包含客户端中途放弃的响应；它是代理等待时间，不是上游处理耗时，也不能单凭该数字确定哪一层慢。日志不保留会话 ID 等路径后缀、查询参数、请求正文或任意原始路径，每个网关首条立即记录、后续采样在 30 秒窗口内聚合。不改变超时、重试或缓存策略。

`upstreamTimeoutMs` 既用于上游传输等待，也配置了入站完整请求的接收期限；持续上传不保证避开这个总期限，Node 的定期检查会影响实际触发时刻。不要仅凭 HTTP 400 就删除配对、清空 App 数据或自动重发。先区分拒绝来源，并查看实际响应正文、Content-Type、准确版本和脱敏的代理上游状态；消息或工具是否已执行不明时，先核对会话结果。

## 不同事件流不能混为一谈

在 DSH 0.2.0-rc.2 中，`/plugins/events` 是插件模块图和构建更新的 SSE，不是对话消息投递通道。它返回 `200`、传输很少字节或反复重连，不能单独证明消息发送成功、失败或处理中动画丢失；同时检查 `/api/remote.mux` WebSocket 与那次操作实际发出的 HTTP 请求。

插件 0.6.15 起为支持认证传输的新专用移动页面修复该通知流的静默超时和 gzip 缓冲：页面以绑定当前授权的标识请求模块事件，网关只在无请求体的 `GET /plugins/events` 收到 `200 text/event-stream` 后按 `upstreamApiTimeoutMs` 等待后续帧。通知中的模块图使用与初始移动页面相同的布局、依赖与模块选择投影，不能用桌面原始模块图替换正在运行的移动布局；保存的新选择仍在下一次加载页面时应用。建连和首响应期限、鉴权、撤销、取消及并发限制不变，标识失效时终止通知，不退回原始模块图或自动刷新会话。旧页面与 `frontend=stock` 不启用这套投影；升级后重新加载专用页面才能使用新通知流。这项修复不代表 [#243](https://github.com/saya-ch/dsh-mobile/issues/243) 的所有启动和重载现象已定位。

页面标识不会迁移到新的认证 Session：原生续期即使保留了当前 WebView 和草稿，也不代表旧模块通知流已恢复。新 Session 使用旧标识会收到 `409 mobile_document_view_invalid`；重新加载专用页面会取得新标识。这个限制不要求删除配对，也不会主动刷新当前会话。

普通消息的气泡和清空草稿可能先于 `POST /api/session/prompt`，属于本地乐观回显，不是 Host 受理确认。若找不到对应请求，请保留脱敏后的请求时序、状态码及 DSH 日志，区分浏览器未发起、代理拒绝与 Host 已受理。插件不会自动重放消息、审批或其他写请求；结果不明时先确认会话，避免重复副作用。

## 慢速传输可能超过默认等待时间

DSH 0.2.0-rc.2 的 API 网关默认每 **2 秒**发送一次 WebSocket Ping，连续两次未收到 Pong 后会结束连接，实际容忍时间约为 **4–6 秒**。客户端另有 **15 秒**的实时连接初始化期限。较大的会话数据、低速上行或拥塞可能延迟 Pong 或首次数据同步，触发断开和重新同步。

在 #146 的部署中，反馈者测量到约 2.18 MiB 的会话窗口与 2.68 Mbps 上行，并报告增大这两个时间后重连减少。这是该部署的观测结果，传输大小和改善程度取决于会话、插件及网络，不能作为通用性能保证。

## 按需增加两个 DSH 参数

确认是上述慢速链路后，可先试 **30 秒心跳间隔**和 **120 秒初始化等待**。这两个参数属于 DSH 已有插件配置，不是 DSH Mobile 的 `upstreamTimeoutMs`；后者不能改变 DSH 的心跳或客户端初始化期限。

在电脑端找到当前 profile 中已启用的 `@deepseek-ai/dsh-api-gateway` 与 `@deepseek-ai/dsh-client-connection` 条目。如果当前 DSH 提供相应配置编辑入口，修改其已有配置；没有入口时，先备份当前 profile 的 `cordis.patch.yml`，再编辑这个文件。命令行 Web 通常使用 `$DSH_HOME/profiles/web/cordis.patch.yml`，官方 Desktop 默认使用 `$DSH_HOME/profiles/desktop/cordis.patch.yml`；自定义 profile 以实际运行配置为准。

下例适用于 DSH 0.2.0-rc.2 的标准 Web/官方 Desktop 组装，现有条目 ID 分别为 `typert-gateway` 和 `connection`。先确认自己的条目 ID；同一个 ID 已有覆盖项时，修改它的 `config`，不要重复插入插件。

```yaml
- id: typert-gateway
  config:
    websocketHeartbeatIntervalMs: 30000

- id: connection
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
    recovery:
      generationReadyTimeoutMs: 120000
```

**Patch 会替换目标条目的整个 `config`。** 以上仅展示标准配置需要保留的可信 Host 表达式与两个调整项；若已有自定义 `trustedHosts`、Cookie 有效期、请求大小、`streamInboxBytes` 或其他 `recovery` 参数，须一并保留。把修改合入原文件的顶层 YAML 列表，保留其他条目；不要用示例覆盖整个文件或修改 `node_modules`。

保存后重启当前 DSH 实例，并重新打开手机页面，让页面取得新的客户端恢复参数。若启动提示条目不存在或字段不支持，恢复备份，核对当前 DSH 版本和配置；不同版本或自定义组装不要直接套用本例。

## 调整后检查效果

重新打开原先会反复重连的会话，比较连接持续时间、重连次数和实际传输量。30 秒心跳会让真正失联的发现变慢，120 秒初始化期限也会让失败连接等待更久；如果没有改善，恢复原值并继续定位，不要无限放大等待时间。通道带宽不会因延长时间而增加，也不能修复认证、代理或服务端故障。

参数与默认值已按 DSH 0.2.0-rc.2 核对：[API 网关配置与心跳实现](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.0-rc.2/packages/api/gateway/src)、[客户端恢复配置](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/client/connection/src/recovery-config.ts)、[标准 Web 条目](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.0-rc.2/packages/bundle/web-app/cordis.patch.yml)。

## 可选的 WebSocket 压缩

从 DSH Mobile 0.5.4 起，可以为指定的实时连接路径启用压缩；**0.8.0 起默认压缩 `/api/remote.mux`**。它以额外 CPU 和内存开销换取较少的传输量，适合带宽有限、计量网络或会话数据较大的场景。如需回到不压缩的转发，把 `paths` 设为 `[]`。

默认已经启用；若要显式声明或调整，可在当前 `mobile-access` 条目的已有 `config` 中加入下面这段属性；这是**配置片段，不是完整 profile patch**。保留该条目已有的网卡、证书、配对状态与管理设置，不要用这个片段替换整个 `config`。

```yaml
websocketCompression:
  paths:
    - /api/remote.mux
```

`/api/remote.mux` 是当前 DSH 的主要实时数据路径。这里只选择要压缩的**准确路径**，不会新增访问权限；设备认证、Host/Origin 与 WebSocket 放行规则仍需通过。社区插件的路径若需要压缩，应先确认并通过连接诊断放行，再加入这个列表。压缩只在手机／浏览器与移动网关之间协商，与 DSH 之间仍不压缩；每条消息不复用先前消息的压缩字典。网关转发两端真实的 Ping/Pong，不另设心跳，也不会因此修改上文的 DSH 等待时间。

以下可选字段与 `paths` 同级，通常保持默认即可：

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `maxMessageBytes` | `33554432`（32 MiB） | 单条解压后消息的上限；超过时结束该连接 |
| `maxQueuedBytes` | `67108864`（64 MiB） | 每个转发方向的待发送数据与帧头上限；至少覆盖消息上限加 14 字节帧头 |
| `thresholdBytes` | `1024` | 向手机／浏览器发送消息时，小于此大小不尝试压缩 |
| `concurrencyLimit` | `4` | 压缩任务并发上限；`ws` 在当前进程首次建立压缩连接时确定这个共享上限，改动后重启 DSH |
| `level` | `3` | 压缩等级（0–9）；提高可能增加 CPU 开销 |

修改后重启 DSH 并重新打开手机页面。可在开发者工具中查看 WebSocket 握手是否协商了 `permessage-deflate`；客户端没有协商时仍可无压缩连接。对比同一会话的实际通道传输量与 CPU 使用，不能仅以开发者工具显示的解压后消息长度判断节省比例。需要关闭时把 `paths` 改回 `[]`；压缩不能提高服务商限额，也不能替代连接故障排查。

### 什么时候值得开启

可压缩的大消息经过受限带宽时，压缩通常更有价值。在隔离 Gateway／`ws` 测试中，合成的重复文本样本从 8 KiB 对应的 8,196 字节降到 249 字节，从 64 KiB 对应的 65,546 字节降到 692 字节。这是 WebSocket 帧字节，不含 TLS／TCP 开销，也不是实际会话的测量；压缩率取决于具体内容。

使用默认 1 KiB 阈值并协商禁用上下文复用时，测试中的 1,023 字节消息没有压缩。不可压缩的 64 KiB 数据反而增加 22 字节，本地往返增加约 1.1 ms。局部限速测试中，重复文本的传递延迟有所下降，但不能据此预测具体蜂窝、转发或局域网体验；本轮未测量持续负载内存和真机行为。

请对相同工作负载分别开关压缩再比较。HTTP 历史响应与 `/api/remote.mux` 消息是不同路径，不能将同时升级多个组件后的会话切换改善全部归因于 WebSocket 压缩。0.8.0 起主实时路径默认开启，其他路径仍须明确配置。

## 静态资源缓存与重复下载

网关自有静态资源（`/mobile-access/compat.js`、`mobile-layout.js`、自定义 CSS/JS）使用带引号的内容 ETag 和 `Cache-Control: private, no-cache`。浏览器可保存正文，但每次复用前必须重新校验；网关先检查设备授权和当前资源，再处理 GET/HEAD 条件请求，内容未变时返回 `304`，文件改动后返回新正文。实际缓存复用仍取决于浏览器行为。

自有静态资源达到 1 KiB 且客户端接受 gzip 时会压缩，维护 `Vary: Accept-Encoding`，并为 gzip 和未压缩表示分别使用内容 ETag。低于阈值的资源保持未压缩。`304` 不携带正文，也不执行压缩；实际节省取决于文件内容和客户端缓存行为，不能据此保证蜂窝网络速度。

0.8.0 起，启动文档按内容哈希引用兼容性脚本（`/mobile-access/compat-<sha256>.js`），该路径使用 `private, max-age=31536000, immutable`。浏览器保留缓存时可直接复用同版本脚本，内容变化则使用新地址；摘要与当前正文不符时返回 `404`。旧的 `/mobile-access/compat.js` 地址继续提供条件校验。服务器收到请求后仍先验证授权；本地已缓存的脚本不含凭据，也不赋予 API 访问权限。

移动启动 HTML 包含绑定当前认证 Session 的页面标识，保持 `no-store`，不复用其他页面或 Session 的启动文档；配对页和 API 响应也保持 `no-store`。网关对上游静态资源做流式 gzip 时，可保留合法上游 ETag 的弱校验形式，并维护 `Vary: Accept-Encoding`；不会把原始内容的长度或范围元信息当作压缩内容的元信息，也不会缓存失败响应。API 响应默认也不新增缓存；下面「可选的 API 读取缓存」是唯一的、需要显式开启的例外。
可压缩的文本响应都走这条流式管道：静态资源、HTML 文档和 `/api/` 的 JSON 都会在手机声明 `Accept-Encoding: gzip` 时压缩，并维护 `Vary`。`/plugins/`、`/assets/` 下的静态资源**沿用原有判定，行为不变**（包括上游原本就会压缩的路径）。静态路径之外，`text/event-stream` 保持不压缩，否则逐帧事件会被 gzip 块缓冲；声明长度小于 1KB 或没有声明长度的响应也保持原样，压缩开销大于收益或可能被逐段消费。范围请求、已编码响应和 304 仍按原规则处理，不带 `Accept-Encoding` 的客户端收到的字节与以前一致。

移动端启动页由网关拼装，不经过上面的代理压缩流程；正文至少 1KiB 且请求接受 gzip 时会压缩，压缩和未压缩响应都维护 `Vary: Accept-Encoding`。页面仍使用 `no-store`，不复用旧启动文档；它包含当前会话与模块选择对应的启动信息。

网关把上游应用模块组合为启动批（`/mobile-access/mobile-boot/<hash>.js`），按 3MiB 源码目标大小切分，最多保留 16 个合并批，始终保留移动布局替换；超出数量的模块改用其原有独立资源地址，不因这项优化拒绝整个启动图。大于目标大小的单个模块不会拆开，原有单模块和组装大小限制不变。较小的响应和缓存复用可减少重复传输，但不能保证总启动时间或修复所有自动重连原因。合并批使用带引号 ETag 和 `private, max-age=30, must-revalidate`：短时间内重载可复用本地副本；布局文件改动后，已缓存的旧批最多可继续使用 30 秒，随后重新校验。ETag 与正文绑定，内容改变后返回新正文而不是 304。

上游未提供校验标识的资源不会因此自动得到一个可靠标识。检查重复下载时，比较同一完整资源 URL 在普通打开、重新加载和 App 冷启动中的 `200`/`304`、缓存命中、`If-None-Match`、编码与实际传输量；不要先清除站点数据再把结果当作正常缓存行为。HTTP 校验语义改善不保证每个 WebView 都会复用缓存，也不能仅凭这些响应头认定 [#107](https://github.com/saya-ch/dsh-mobile/issues/107) 已完全解决。

## 可选的缓存：数据读、静态资源与历史页（0.9.0 起）
默认仍保持「读到的都是新鲜的」：三个缓存组默认都关闭，网关不缓存任何响应，行为与之前完全一致。慢链路上可以按需分别开启，代价是各自明确的陈旧窗口。

### 数据读缓存（`contentCacheTtlMs`，默认 `0`）

- **只缓存白名单路径**：`contentCachePaths` 默认 `["/api/sessions"]`，按前缀匹配自身与子路径，不命中 `/api/sessions-cookie`；设为 `[]` 表示不缓存。
- **只缓存可安全重放的内容**：状态 200、完整 JSON 正文、无 `Set-Cookie`、上游未标 `no-store`/`private`、未编码；单条 256KB，条目数另有上限（`contentCacheMaxEntries`，默认 256），避免空正文或小正文堆满条目。
- **新鲜度三道闸**：任何非 GET/HEAD 请求清空整组；条目只在窗口内直接重放；过期后若上游带 `ETag`，发 `If-None-Match` 校验，只有 `304` 才刷新并重放，否则回源。
- 进度的写入发生在请求途中的情况由代际计数拦下：写入已清空的旧正文不会被回存。

### 静态资源缓存（`contentCacheAssetTtlMs`，默认 `0`）

- **白名单**：`contentCacheAssetPaths` 默认 `["/plugins", "/assets", "/mobile-access"]`——插件脚本、接口资源与网关自有文件；只缓存 GET 的脚本/样式/JSON/SVG，不含 `text/event-stream` 与二进制。
- **窗口可以长**（上限 1 小时）：这些文件要么内容寻址、要么带 ETag；过期后同样先条件校验，`304` 才重放，编辑后最多等一个窗口。
- **写请求不会清空这一组**：它们与清单/会话状态无关，只随内容变化。
- 单条上限 2MB；两组各有自己的字节预算与条目上限，取值同为 `contentCacheMaxBytes`（默认 8MB）与 `contentCacheMaxEntries`（默认 256）。

所有缓存组的共同保证：响应仍是 `Cache-Control: no-store`（不改浏览器策略）；重放带 `Age` 与 `X-DSH-Mobile-Cache: hit`，校验后重放为 `revalidated`；重放按调用方 `Accept-Encoding` 重新压缩，存储的是 identity 正文；上传、写请求、事件流、范围请求、带 `Set-Cookie` 或需要重新认证的响应永不缓存。

### 对话历史页缓存（`contentCacheHistoryTtlMs`，默认 `0`）

历史分页是 POST 读方法（`session/page`），不走上面的 GET 缓存，因此单列一组：

- **默认只认一种读**：路径在 `contentCacheHistoryPaths`（默认 `["/api/session"]`），且 JSON 请求体的 `method` 在 `contentCacheHistoryMethods`（默认 `["page"]`）；路径本身以 `/page` 结尾时（如 `POST /api/session/page`）不再要求 body 声明方法。其他方法（`prompt`、`create` 等）永远不缓存，并且会被当作写请求清空本组。
- **键包含请求体**：设备 + 路径 + body 的 SHA-256。翻页到不同游标就是不同条目，不会把上一页当成下一页重放。
- **窗口短**（0–60 秒）。任何写请求都会清空整组；历史页读本身不清。
- **边界**：请求体需带 `content-length`、≤64KB、`content-type` 为 JSON；响应需 200、完整 JSON、无 `Set-Cookie`、上游未标 `no-store`/`private`，单条 ≤256KB，条目数同样受 `contentCacheMaxEntries` 约束。不满足就旁路，行为与未开启一致。
- **代价**：窗口内重新打开会话，看到的可能是上一次读到的分页；Agent 新产生的事件不经过写请求，因此不会被这道清空拦下。建议 5–15 秒，不要在窗口内期待看到刚发生的消息。

配置片段（放进现有 `mobile-access` 条目的 `config`）：

```yaml
contentCacheTtlMs: 15000                 # 数据读：15 秒
contentCacheAssetTtlMs: 600000           # 静态资源：10 分钟
contentCacheHistoryTtlMs: 8000           # 历史页：8 秒
# contentCachePaths: ["/api/sessions", "/api/changes"]
# contentCacheAssetPaths: ["/plugins", "/assets", "/mobile-access"]
# contentCacheMaxBytes: 8388608
# contentCacheMaxEntries: 256
```

判断是否生效：同一路径第二次请求出现 `X-DSH-Mobile-Cache: hit`（过期校验后为 `revalidated`），上游对应请求计数不再增加。数据组越大越省流量，但窗口内看到的是上一次读到的内容；刷新页面或任何写操作会让它回源。

### 适用范围与已验证收益

- **静态资源组**在真实 DSH 0.2.1-rc.2 上实测：启动文档里 4 个 `/assets/*` 资源共 1,785,636 B，重复加载 4/4 命中（`X-DSH-Mobile-Cache: hit`），1.79 MB 不再回源。
- **两个读组只对把读方法暴露成 HTTP 的部署有效。** DSH 0.2.x 的会话列表与历史页在 `/api/remote.mux` 的 WebSocket 帧上（`session/list`、`session/page`），默认白名单（`/api/sessions`；`/api/session` + `page`）不会命中；服务器实测这些 HTTP 路由返回 `404`，同版本存在的 `/api` 路由只有 `changes.summary`、`session.export`、`present.open`、`file`、`session/uploadFileBinary`、`remote.mux` 等。这些组默认关闭；在其它部署上开启前，先用 `X-DSH-Mobile-Cache` 确认目标路由确实存在。

## 手动压缩会话与长时间 API 请求（0.6.0）

手机发出的 `/compact` 等命令要通过移动网关的 HTTP API；DSH 内部触发的自动压缩不经过这次网关请求。旧版网关对所有上游代理请求都使用默认 30 秒的 `upstreamTimeoutMs`，因此模型仍在生成摘要时，手动压缩可能先收到 `502 upstream_unavailable`。[#171](https://github.com/saya-ch/dsh-mobile/issues/171) 记录了这一情况。

当前网关区分传输等待和已鉴权 API 的响应等待。`upstreamTimeoutMs` 仍默认 30000 毫秒（1000–300000），用于上传、静态资源、启动资源和 WebSocket 握手的等待；请求头另有既有的 10 秒接收期限。完成设备鉴权、Host/Origin 与必要 CSRF 检查的 `/api` 和 `/api/…` HTTP 请求，在请求体发往 DSH 后切换到 `upstreamApiTimeoutMs`。该字段默认 `0`，表示不对这些响应施加空闲超时；需要限制时，可配置为 `1–2147483647` 的整数毫秒，范围上限来自 Node 定时器的表示范围。插件 0.6.15 起，专用模块事件流在收到有效响应头后也使用此字段，适用条件见上面的通知流说明。这不是整个操作的总执行期限：持续到达的响应数据会重置空闲计时。

以下属性放进现有 `mobile-access` 条目的 `config`，并保留其他配置；这是配置片段，不是完整的 profile 补丁。`0` 是默认值，示例为 API 响应设置 10 分钟的空闲等待期限：

```yaml
upstreamApiTimeoutMs: 600000
```

保存后重启 DSH。设备/会话失效、撤销、调用方断开或网关关闭仍会中止代理请求；上传大小、上传等待、连接数、并发请求数和 CSRF 限制不因 `0` 而关闭。隧道、反向代理或模型服务商自己的期限仍可能提前结束请求；该字段也不会改变前文的 WebSocket 心跳或初始化设置。

普通 HTTP 代理请求在尚未发送响应头时，移动网关自己的上游超时返回 `504 {"error":"upstream_timeout"}`；一般连接失败仍为 `502 upstream_unavailable`。若流已经开始，则只能关闭连接，不能再发送第二份 HTTP 状态。网关不会自动重试 API 请求。超时或断开仅表示调用方停止等待，不保证 DSH 或模型任务已经停止，也不会撤销已经发生的副作用；重试操作前先检查实际会话结果。
