# 电脑端扩展 Worker 模式

[English](EXTENSION_WORKERS.en.md) · [返回定制功能](../README.md#扩展与自定义)

> 插件 0.6.3 候选功能，尚未发布。此功能由电脑端插件实现，不要求 App 同步版本或重新配对。

Worker 模式把选中的本地 `host.mjs` 放到独立工作线程，使同步 JavaScript 循环不再占住网关主线程。默认仍使用 `in-process`；已有扩展和普通 Cordis 插件不会被自动迁移。

## 适合哪些扩展

适合通过 `/mobile` 或本地目录创建、使用 Node.js 与扩展 API 的可信代码。Worker 内仍可使用 `api.manifest`、`api.schema`、`api.action`、`api.route`、`api.effect`；`api.context.logger` 只提供 `debug`、`info`、`warn`、`error`，不是完整的 Cordis Context 或 Logger。需要直接使用 Cordis 服务的扩展保留进程内模式，不会静默回退。

Worker **不是安全沙箱**：代码仍有本机用户权限，可以访问文件、网络和进程。V8 内存限制不覆盖全部原生／ArrayBuffer 内存，也不能保证全进程不会 OOM。停止线程不保证执行清理回调，不撤销已经发生的文件或远程操作。[Node 的限制说明](https://nodejs.org/download/release/v22.19.0/docs/api/worker_threads.html#new-workerfilename-options)。

## 按需启用

在当前 DSH profile 的 `mobile-access` 配置中添加以下字段，再正常重启或重新加载插件；不要修改 `extension.json`：

```yaml
hostExecution:
  mode: worker
  extensions:
    - media-remote
  maxWorkers: 8
```

`extensions` 只选择这些本地扩展 ID，其他扩展继续进程内执行；省略列表选择所有本地 Host，空列表不选择任何 Host。配置放在实际承载插件的 profile，Desktop 与 Web 的 profile 不应混用。恢复 `mode: in-process` 后正常重新加载插件即可关闭 Worker 模式。

## 扩展停止后

电脑端打开 **移动访问**。停止的 Worker 会显示“扩展需要重启”；点击目标扩展的“重启扩展”并确认。此卡片在局域网、远程和诊断视图共用。只有不可用的 Worker 显示该入口，不自动重启，也不要求改文件来触发恢复。

触发截止的调用保留超时结果；同一 Worker 中其他未完成调用会收到 `extension_host_unavailable`。其他运行实例不会被一起终止。已发出响应头的流会结束连接，不能在半截内容后补一份 JSON 错误。未完成动作不自动重放；恢复前请确认已经产生的副作用是否需要处理。

同一扩展存在尚未结束的废弃工作时，新请求仍可能收到 `extension_busy`；线程退出确认或对应工作真正结束后才释放记账。正在退出、保留旧版本及启动中的 Worker 都占线程预算；预算耗尽时不会偷偷使用进程内模式绕过。

## 可调整的预算

| 预算 | `hostExecution` 字段 |
| --- | --- |
| 线程与注册数量 | `maxWorkers`、`maxRegistrations` |
| V8 堆与栈 | `maxOldGenerationSizeMb`、`maxYoungGenerationSizeMb`、`stackSizeMb` |
| 激活、动作、取消与清理 | `activationTimeoutMs`、`operationTimeoutMs`、`cancelGraceMs`、`streamCancelGraceMs`、`disposeGraceMs` |
| 动作 JSON 与流 | `resultMaxBytes`、`streamWindowBytes`、`streamChunkBytes`、`streamAggregateBytes` |
| 日志 | `logWindowMs`、`logMessagesPerWindow`、`logMessageBytes` |

参数必须是范围内的整数；流块不能大于单流窗口，单流窗口不能大于聚合预算。初次启用建议保留默认值。配置定义与校验由 `src/extension-worker-config.ts` 管理。Node 的全局堆参数可能覆盖 Worker 资源配置，因此检测到会覆盖限制的父进程启动参数时，Worker 会在导入扩展前拒绝启动并报告 `extension_worker_heap_override`。请检查 DSH 的启动参数；需要保留这些参数时可继续使用进程内模式，不会静默绕过。

流量按消费确认回填，未读完的 EOF 数据继续占预算；日志和结果在 Worker 内先转换为受限数据，再交给网关。该机制约束传输与 JavaScript 阻塞风险，不是整个操作系统或进程的资源沙箱。
