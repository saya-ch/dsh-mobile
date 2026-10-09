# Computer-side extension Workers

[简体中文](EXTENSION_WORKERS.md) · [Customization](../README.en.md#extend-and-customize)

> Plugin 0.6.3 candidate feature, not yet released. This computer-side feature does not require a matching App version or new pairing.

Worker mode runs selected local `host.mjs` files in separate threads so synchronous JavaScript does not occupy the gateway's event loop. The default remains `in-process`; existing extensions and ordinary Cordis plugins are not automatically migrated.

## Which extensions fit

Use trusted local-directory extensions created through `/mobile` or directly, using Node.js and the extension API. Workers retain `api.manifest`, `api.schema`, `api.action`, `api.route` and `api.effect`; `api.context.logger` provides only `debug`, `info`, `warn` and `error`, not the full Cordis Context or Logger API. Extensions needing live Cordis services stay in-process. Incompatible hosts do not silently fall back.

Workers are **not a security sandbox**. Code retains local-user access to files, networks and processes. V8 limits do not cover all native/ArrayBuffer memory or prevent every process-wide OOM. Termination does not guarantee cleanup callbacks or undo completed file/remote operations. [Node's limitations](https://nodejs.org/download/release/v22.19.0/docs/api/worker_threads.html#new-workerfilename-options).

## Enable selectively

Add these fields to the current DSH profile's `mobile-access` configuration, then normally restart or reload the plugin; do not modify `extension.json`:

```yaml
hostExecution:
  mode: worker
  extensions:
    - media-remote
  maxWorkers: 8
```

`extensions` selects only these local IDs; other extensions remain in-process. Omitting the list selects all local hosts, while an empty list selects none. Configure the actual profile that loads the plugin rather than mixing Desktop and Web profiles. Restore `mode: in-process` and reload normally to disable Worker execution.

## When an extension stops

Open **Mobile Access** on the computer. An unavailable Worker appears under “Extensions need a restart”; choose its restart action and confirm. The card is shared across LAN, remote and diagnostics views. Ready Workers do not show the action. Recovery is explicit: no automatic restart or meaningless file edits.

The invocation that triggered a deadline keeps its timeout result; other pending calls in that Worker receive `extension_host_unavailable`. Other runtime instances are not terminated together. A stream whose headers were already sent loses its connection; it cannot append a new JSON error after a partial body. Interrupted actions are never replayed. Check whether completed side effects require attention before restarting.

New calls can still receive `extension_busy` while abandoned work remains unfinished. Accounting clears only on actual completion or confirmed thread exit. Starting, retained-generation and terminating Workers all occupy the thread budget; exhaustion does not silently switch execution to in-process.

## Adjustable budgets

| Budget | `hostExecution` fields |
| --- | --- |
| Threads and registrations | `maxWorkers`, `maxRegistrations` |
| V8 heap and stack | `maxOldGenerationSizeMb`, `maxYoungGenerationSizeMb`, `stackSizeMb` |
| Activation, actions, cancellation and cleanup | `activationTimeoutMs`, `operationTimeoutMs`, `cancelGraceMs`, `streamCancelGraceMs`, `disposeGraceMs` |
| Action JSON and streams | `resultMaxBytes`, `streamWindowBytes`, `streamChunkBytes`, `streamAggregateBytes` |
| Logging | `logWindowMs`, `logMessagesPerWindow`, `logMessageBytes` |

Values must be integers within the accepted ranges. Chunks cannot exceed the per-stream window, and a window cannot exceed the aggregate budget. Start with the defaults. `src/extension-worker-config.ts` owns their definitions and validation. Global Node heap flags can override Worker settings, so detected overriding parent launch flags reject startup before importing the extension with `extension_worker_heap_override`. Check DSH's launch options; keep in-process execution when those flags are required rather than silently bypassing the limits.

Consumption refills stream credit, and unread EOF bytes retain their budget. Logs and results are converted to bounded data inside the Worker before reaching the gateway. This contains transport and JavaScript-blocking risks, not all operating-system or process resources.
