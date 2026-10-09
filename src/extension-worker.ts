/** Supervise opt-in local hosts without executing extension code on the DSH thread. */
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { Readable } from 'node:stream'
import { MobileExtensionError, type LocalExtensionManifest, type MobileRouteRequest, type MobileRouteResponse } from './extensions.js'
import { resolveHostExecution, type HostExecutionConfig, type ResolvedHostExecutionConfig } from './extension-worker-config.js'
import { WORKER_RESPONSE_METADATA_MAX_BYTES, type ParentMessage, type WorkerActionMetadata, type WorkerRouteMetadata } from './extension-worker-protocol.js'

/** JSON bytes serialized and size-checked inside the worker. */
export class PreparedJsonResult { constructor(readonly bytes: Buffer) {} }
/** Identify worker results without invoking an extension serializer in the gateway. */
export function isPreparedJson(value: unknown): value is PreparedJsonResult { return value instanceof PreparedJsonResult }
/** Resolve the installed standalone entry adjacent to the plugin bundle. */
export function defaultExtensionWorkerModule(): URL { return new URL('./extension-worker-runtime.mjs', import.meta.url) }
/** Worker context is logger-only, never a Cordis Context or service proxy. */
export type WorkerParentLogger = Record<'debug' | 'info' | 'warn' | 'error', (...args: unknown[]) => void>

/** Every thread counts until actual exit, including activation, retirement and termination. */
export class ExtensionWorkerBudget {
  private count = 0
  constructor(readonly maximum: number) {}
  get current(): number { return this.count }
  reserve(): () => void {
    if (this.count >= this.maximum) throw new MobileExtensionError('extension_worker_limit', 'local extension worker limit reached', 503)
    this.count += 1
    let released = false
    return () => { if (!released) { released = true; this.count -= 1 } }
  }
}
export interface ExtensionWorkerHostOptions {
  readonly workerModule: string | URL
  readonly hostFile: string
  readonly manifest: LocalExtensionManifest
  readonly generation: string
  readonly logger: WorkerParentLogger
  readonly activationTimeoutMs?: number
  readonly limits?: HostExecutionConfig
  readonly budget?: ExtensionWorkerBudget
  readonly onUnavailable?: (error: MobileExtensionError) => void
}
export interface ExtensionWorkerActivation {
  readonly runtimeId: string
  readonly actions: readonly WorkerActionMetadata[]
  readonly routes: readonly WorkerRouteMetadata[]
}
interface PendingRpc<T> { readonly resolve: (value: T) => void; readonly reject: (error: Error) => void; readonly cleanup: () => void }
interface LiveStream { readonly bridge: WorkerStreamBridge; unacked: number; ended: boolean; cancelTimer?: NodeJS.Timeout }
/** Diagnostic count; production admission uses an instance-owned budget. */
export const activeWorkerCount = { current: 0 }
const LIFECYCLE_ID = 'lifecycle'

/** Node accepts quoted NODE_OPTIONS words; inspect option names without exposing their values. */
function nodeOptionWords(value: string): string[] {
  const words:string[]=[]
  let word='';let quoted=false;let escaped=false
  for(const character of value){
    if(escaped){word+=character;escaped=false;continue}
    if(character==='\\'){escaped=true;continue}
    if(character==='"'){quoted=!quoted;continue}
    if(/\s/u.test(character)&&!quoted){if(word!==''){words.push(word);word=''};continue}
    word+=character
  }
  if(word!=='')words.push(word)
  return words
}

/** Known parent V8 heap flags take precedence over Worker resourceLimits. */
export function parentWorkerHeapOverrides(argv:readonly string[],nodeOptions:string|undefined):readonly string[]{
  const heapFlags=new Set(['--max-old-space-size','--max-semi-space-size','--max-heap-size','--max-old-space-size-percentage'])
  const found=new Set<string>()
  for(const argument of [...argv,...nodeOptionWords(nodeOptions??'')]){
    const name=argument.split('=',1)[0]!.replaceAll('_','-')
    if(heapFlags.has(name))found.add(name)
  }
  return Object.freeze([...found])
}
const initialNodeOptions=process.env.NODE_OPTIONS

export class ExtensionWorkerHost {
  private readonly limits: ResolvedHostExecutionConfig
  private readonly worker: Worker
  private readonly pending = new Map<string, PendingRpc<PreparedJsonResult>>()
  private readonly routePending = new Map<string, PendingRpc<MobileRouteResponse>>()
  private readonly streams = new Map<string, LiveStream>()
  private readonly detachedRoutes = new Set<string>()
  private readonly executionGrace = new Map<string, NodeJS.Timeout>()
  private readonly exited: Promise<void>
  private readonly unavailableController = new AbortController()
  private termination: Promise<void> | undefined
  private activation: ExtensionWorkerActivation | undefined
  private dead = false
  private disposed = false
  private maxBufferedBytes = 0
  private cancelledStreams = 0
  private logWindowStart = Date.now()
  private logCount = 0
  private stdioBytes = 0
  private stdioResume: NodeJS.Timeout | undefined

  constructor(private readonly options: ExtensionWorkerHostOptions) {
    this.limits = resolveHostExecution(options.limits)
    const overrides=new Set(parentWorkerHeapOverrides(process.execArgv,initialNodeOptions))
    for(const flag of parentWorkerHeapOverrides([],process.env.NODE_OPTIONS))overrides.add(flag)
    if(overrides.size>0)throw new MobileExtensionError('extension_worker_heap_override',`worker heap limits require launching DSH without ${[...overrides].join(', ')}`,503)
    const release = options.budget?.reserve() ?? (() => undefined)
    try {
      this.worker = new Worker(options.workerModule, {
        workerData: { limits: this.limits }, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: this.limits.maxOldGenerationSizeMb, maxYoungGenerationSizeMb: this.limits.maxYoungGenerationSizeMb, stackSizeMb: this.limits.stackSizeMb },
      })
    } catch (error) { release(); throw error }
    // Extension console output has no ambient parent stdout; only the bounded logger adapter is forwarded.
    const drainConsole = (chunk: Buffer): void => {
      this.stdioBytes += chunk.byteLength
      if (this.stdioBytes < this.limits.logMessageBytes * this.limits.logMessagesPerWindow || this.stdioResume !== undefined) return
      this.worker.stdout?.pause(); this.worker.stderr?.pause()
      this.stdioResume = setTimeout(() => {
        this.stdioResume = undefined; this.stdioBytes = 0
        if (!this.dead) { this.worker.stdout?.resume(); this.worker.stderr?.resume() }
      }, this.limits.logWindowMs)
      this.stdioResume.unref()
    }
    this.worker.stdout?.on('data', drainConsole); this.worker.stderr?.on('data', drainConsole)
    this.worker.unref()
    activeWorkerCount.current += 1
    this.exited = new Promise<void>(resolve => {
      this.worker.once('exit', () => {
        this.dead = true
        if (this.stdioResume !== undefined) clearTimeout(this.stdioResume)
        this.markUnavailable()
        release(); activeWorkerCount.current -= 1
        for (const timer of this.executionGrace.values()) clearTimeout(timer)
        this.executionGrace.clear()
        const error = this.unavailable()
        for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(error) }
        for (const entry of this.routePending.values()) { entry.cleanup(); entry.reject(error) }
        this.pending.clear(); this.routePending.clear(); this.detachedRoutes.clear()
        for (const live of this.streams.values()) {
          if (live.cancelTimer !== undefined) clearTimeout(live.cancelTimer)
          live.bridge.destroy(error)
        }
        this.streams.clear()
        resolve()
      })
    })
    this.worker.on('message', (raw: unknown) => {
      try { this.handleMessage(raw) } catch (error) { void error; void this.terminate('invalid-worker-message') }
    })
    this.worker.on('error', () => { void this.terminate('worker-error') })
  }
  /** A stopped generation never silently respawns. */
  available(): boolean { return !this.dead && this.termination === undefined && !this.disposed && !this.unavailableController.signal.aborted }
  /** Activate once and receive executable-free registration metadata. */
  async activate(): Promise<ExtensionWorkerActivation> {
    let timer: NodeJS.Timeout | undefined
    try {
      const reply = new Promise<PreparedJsonResult>((resolve, reject) => {
        this.pending.set(LIFECYCLE_ID, { resolve, reject, cleanup: () => undefined })
        this.post({ kind: 'activate', id: LIFECYCLE_ID, hostFile: this.options.hostFile, generation: this.options.generation, manifest: this.options.manifest })
      })
      await Promise.race([reply, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new MobileExtensionError('host_load_timeout', 'extension worker activation timed out', 500)), this.options.activationTimeoutMs ?? this.limits.activationTimeoutMs)
      })])
      if (this.activation === undefined) throw new MobileExtensionError('host_activation_failed', 'extension worker activation failed', 500)
      return this.activation
    } catch (error) { await this.terminate('activation-failed'); throw error }
    finally { if (timer !== undefined) clearTimeout(timer) }
  }
  actionMetadata(): readonly WorkerActionMetadata[] { return this.activation?.actions ?? [] }
  routeMetadata(): readonly WorkerRouteMetadata[] { return this.activation?.routes ?? [] }

  /** Underlying action: settles only when execution completes or the thread exits. */
  invokeExecution(action: string, input: unknown, caller: { readonly signal: AbortSignal; readonly deviceId: string }): Promise<PreparedJsonResult> {
    if (!this.available()) return Promise.reject(this.unavailable())
    if (caller.signal.aborted) return Promise.reject(caller.signal.reason)
    const id = randomUUID()
    return new Promise<PreparedJsonResult>((resolve, reject) => {
      const onAbort = (): void => { this.post({ kind: 'cancel', id }); this.armExecutionGrace(id) }
      caller.signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, { resolve, reject, cleanup: () => { caller.signal.removeEventListener('abort', onAbort); this.settleExecutionGrace(id) } })
      try { this.post({ kind: 'invoke', id, action, deviceId: caller.deviceId, input }) }
      catch (error) { this.pending.get(id)?.cleanup(); this.pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))) }
    })
  }
  /** Direct caller budget; service dispatch observes invokeExecution separately. */
  invoke(action: string, input: unknown, caller: { readonly signal: AbortSignal; readonly deviceId: string }): Promise<PreparedJsonResult> {
    return this.callerBudget(signal => this.invokeExecution(action, input, { ...caller, signal }), caller.signal,
      this.actionMetadata().find(entry => entry.name === action)?.timeoutMs ?? this.limits.operationTimeoutMs, 'extension_action_timeout')
  }
  /** Underlying route: late streams are cancelled and observed to confirmed end. */
  handleRouteExecution(routeIndex: number, request: MobileRouteRequest): Promise<MobileRouteResponse> {
    if (!this.available()) return Promise.reject(this.unavailable())
    if (request.signal.aborted) return Promise.reject(request.signal.reason)
    const id = randomUUID()
    return new Promise<MobileRouteResponse>((resolve, reject) => {
      const onAbort = (): void => {
        this.post({ kind: 'cancel', id })
        if (this.routePending.has(id)) { this.detachedRoutes.add(id); this.armExecutionGrace(id) }
        this.cancelStream(id)
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.routePending.set(id, { resolve, reject, cleanup: () => { request.signal.removeEventListener('abort', onAbort); this.settleExecutionGrace(id) } })
      try { this.post({ kind: 'route', id, routeIndex, method: request.method, path: request.pathname, query: [...request.query.entries()], headers: request.headers, body: new Uint8Array(request.body), deviceId: request.deviceId }) }
      catch (error) { this.routePending.get(id)?.cleanup(); this.routePending.delete(id); reject(error instanceof Error ? error : new Error(String(error))) }
    })
  }
  /** Handler budget ends at stream-start; stream lifetime remains cancellation-bound. */
  handleRoute(routeIndex: number, request: MobileRouteRequest): Promise<MobileRouteResponse> {
    return this.callerBudget(signal => this.handleRouteExecution(routeIndex, { ...request, signal }), request.signal,
      this.routeMetadata()[routeIndex]?.timeoutMs ?? this.limits.operationTimeoutMs, 'extension_route_timeout', true)
  }
  private async callerBudget<T>(start: (signal: AbortSignal) => Promise<T>, external: AbortSignal, timeoutMs: number, code: string, holdForStream = false): Promise<T> {
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    let detach: ((error: unknown) => void) | undefined
    const onAbort = (): void => { controller.abort(external.reason); detach?.(external.reason ?? new MobileExtensionError('extension_cancelled', 'caller cancelled', 409)) }
    const onUnavailable = (): void => { detach?.(this.unavailableController.signal.reason) }
    if (external.aborted) throw external.reason
    if (!this.available()) throw this.unavailable()
    external.addEventListener('abort', onAbort, { once: true }); this.unavailableController.signal.addEventListener('abort', onUnavailable, { once: true })
    const release = (): void => { external.removeEventListener('abort', onAbort); this.unavailableController.signal.removeEventListener('abort', onUnavailable); if (timer !== undefined) clearTimeout(timer) }
    let retained = false
    try {
      const result = await Promise.race([start(controller.signal), new Promise<never>((_, reject) => {
        detach = reject
        timer = setTimeout(() => { const error = new MobileExtensionError(code, 'extension operation timed out', 500); controller.abort(error); reject(error) }, timeoutMs)
      })])
      if (holdForStream && result !== null && typeof result === 'object' && 'body' in result && result.body instanceof Readable) {
        retained = true
        result.body.once('close', release); result.body.once('end', release)
      }
      return result
    } finally { if (timer !== undefined) clearTimeout(timer); if (!retained) release() }
  }
  streamStats(): { readonly activeStreams: number; readonly maxBufferedBytes: number; readonly cancelledStreams: number; readonly bufferedBytes: number } {
    return { activeStreams: [...this.streams.values()].filter(live => !live.ended).length, maxBufferedBytes: this.maxBufferedBytes, cancelledStreams: this.cancelledStreams, bufferedBytes: this.totalUnacked() }
  }
  /** Graceful effects cleanup followed by termination; completion requires actual exit. */
  async dispose(): Promise<void> {
    if (!this.available()) { await this.terminate('dispose-unavailable'); return }
    this.disposed = true
    let timer: NodeJS.Timeout | undefined
    try {
      const reply = new Promise<PreparedJsonResult>((resolve, reject) => { this.pending.set(LIFECYCLE_ID, { resolve, reject, cleanup: () => undefined }); this.post({ kind: 'dispose', id: LIFECYCLE_ID }) })
      await Promise.race([reply, new Promise<void>(resolve => { timer = setTimeout(resolve, this.limits.disposeGraceMs) })])
    } finally { if (timer !== undefined) clearTimeout(timer); await this.terminate('disposed') }
  }
  whenExited(): Promise<void> { return this.exited }
  /** Stop admission now, retain execution/budget ownership until confirmed thread exit. */
  terminate(reason: string): Promise<void> {
    this.markUnavailable()
    this.termination ??= (async () => { if (!this.dead) await this.worker.terminate(); await this.exited })()
    // Callers may initiate termination from a listener; the lifecycle owner still awaits and reports failures.
    void this.termination.catch(() => undefined)
    void reason
    return this.termination
  }
  private unavailable(): MobileExtensionError { return new MobileExtensionError('extension_host_unavailable', `extension ${this.options.manifest.id} worker is unavailable; explicit recovery is required`, 503) }
  private markUnavailable(): void {
    if (this.unavailableController.signal.aborted) return
    const error = this.unavailable(); this.unavailableController.abort(error)
    try { this.options.onUnavailable?.(error) } catch (cause) { void cause /* Observer failures cannot prevent thread termination. */ }
  }
  private armExecutionGrace(id: string): void {
    if (this.executionGrace.has(id) || !this.available()) return
    const timer = setTimeout(() => { this.executionGrace.delete(id); if (this.pending.has(id) || this.routePending.has(id)) void this.terminate('cancel-unresponsive') }, this.limits.cancelGraceMs)
    timer.unref(); this.executionGrace.set(id, timer)
  }
  private settleExecutionGrace(id: string): void { const timer = this.executionGrace.get(id); if (timer !== undefined) clearTimeout(timer); this.executionGrace.delete(id) }
  private post(message: ParentMessage): void { if (!this.dead && this.termination === undefined) this.worker.postMessage(message) }
  private handleMessage(raw: unknown): void {
    if (this.dead || raw === null || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    if (message.kind === 'log') {
      if (message.level !== 'debug' && message.level !== 'info' && message.level !== 'warn' && message.level !== 'error') return
      if (!Array.isArray(message.args) || message.args.some(arg => typeof arg !== 'string')) return
      if (Date.now() - this.logWindowStart >= this.limits.logWindowMs) { this.logWindowStart = Date.now(); this.logCount = 0 }
      if (++this.logCount > this.limits.logMessagesPerWindow || Buffer.byteLength(message.args.join('')) > this.limits.logMessageBytes) return
      try { this.options.logger[message.level](...message.args) } catch (error) { void error /* Logger failures do not change an extension outcome. */ }
      return
    }
    if (typeof message.runtimeId !== 'string') return
    if (this.activation !== undefined && message.runtimeId !== this.activation.runtimeId) return
    if (message.kind === 'activated') {
      if (this.activation !== undefined || !Array.isArray(message.actions) || !Array.isArray(message.routes)) throw new Error('invalid activation metadata')
      const actions = message.actions as WorkerActionMetadata[]
      const routes = message.routes as WorkerRouteMetadata[]
      if (actions.length + routes.length > this.limits.maxRegistrations) throw new Error('worker registration limit exceeded')
      for (const action of actions) if (typeof action?.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(action.name)) throw new Error('invalid action metadata')
      for (const route of routes) if (typeof route?.method !== 'string' || typeof route.path !== 'string') throw new Error('invalid route metadata')
      this.activation = Object.freeze({ runtimeId: message.runtimeId, actions: Object.freeze(actions), routes: Object.freeze(routes) })
      const pending = this.pending.get(LIFECYCLE_ID); this.pending.delete(LIFECYCLE_ID); pending?.cleanup(); pending?.resolve(new PreparedJsonResult(Buffer.alloc(0)))
      return
    }
    if (typeof message.id !== 'string') return
    const id = message.id
    if (message.kind === 'result' || message.kind === 'error') {
      const pending = this.pending.get(id); this.pending.delete(id); pending?.cleanup()
      if (message.kind === 'result') {
        if (!(message.bytes instanceof Uint8Array) || message.bytes.byteLength > this.limits.resultMaxBytes) { pending?.reject(new MobileExtensionError('extension_failed', 'invalid worker result', 500)); return }
        pending?.resolve(new PreparedJsonResult(Buffer.from(message.bytes)))
      } else {
        const error = new MobileExtensionError(typeof message.code === 'string' ? message.code.slice(0, 64) : 'extension_failed', typeof message.message === 'string' ? message.message.slice(0, 500) : 'extension failed', typeof message.status === 'number' && Number.isInteger(message.status) && message.status >= 400 && message.status <= 599 ? message.status : 500)
        pending?.reject(error)
        const route = this.routePending.get(id); this.routePending.delete(id); this.detachedRoutes.delete(id); route?.cleanup(); route?.reject(error)
      }
      return
    }
    if (message.kind === 'route-response' || message.kind === 'stream-start') {
      const route = this.routePending.get(id)
      if (route === undefined) { if (message.kind === 'stream-start') this.post({ kind: 'stream-cancel', id }); return }
      if (message.kind === 'stream-start' && this.detachedRoutes.has(id)) { this.cancelledStreams += 1; this.post({ kind: 'stream-cancel', id }); return }
      const response = responseMetadata(message)
      this.routePending.delete(id); this.detachedRoutes.delete(id)
      if (message.kind === 'route-response') {
        route.cleanup()
        if (!(message.bytes instanceof Uint8Array) || message.bytes.byteLength > this.limits.resultMaxBytes) { route.reject(new MobileExtensionError('invalid_route_response', 'invalid worker route response', 500)); return }
        route.resolve({ ...response, body: Buffer.from(message.bytes) })
      } else {
        this.settleExecutionGrace(id)
        const live = this.openStream(id, route.cleanup)
        route.resolve({ ...response, body: live.bridge })
      }
      return
    }
    if (message.kind === 'stream-chunk') {
      const live = this.streams.get(id)
      if (live === undefined || live.ended || live.bridge.destroyed) return
      if (!(message.bytes instanceof Uint8Array) || message.bytes.byteLength > this.limits.streamChunkBytes || live.unacked + message.bytes.byteLength > this.limits.streamWindowBytes || this.totalUnacked() + message.bytes.byteLength > this.limits.streamAggregateBytes) throw new Error('worker exceeded stream credit')
      live.unacked += message.bytes.byteLength
      this.maxBufferedBytes = Math.max(this.maxBufferedBytes, this.totalUnacked())
      live.bridge.push(Buffer.from(message.bytes))
      return
    }
    if (message.kind === 'stream-end' || message.kind === 'stream-error') {
      this.settleExecutionGrace(id)
      const detached = this.routePending.get(id)
      if (this.detachedRoutes.delete(id)) { this.routePending.delete(id); detached?.cleanup(); detached?.reject(new MobileExtensionError('extension_cancelled', 'caller detached', 409)) }
      const live = this.streams.get(id)
      if (live === undefined) return
      live.ended = true
      if (live.cancelTimer !== undefined) clearTimeout(live.cancelTimer)
      if (message.kind === 'stream-error') live.bridge.destroy(new Error(typeof message.message === 'string' ? message.message.slice(0, 500) : 'worker stream failed'))
      else if (live.bridge.destroyed) this.streams.delete(id)
      else live.bridge.push(null)
    }
  }
  private totalUnacked(): number { let total = 0; for (const live of this.streams.values()) total += live.unacked; return total }
  private openStream(id: string, cleanup: () => void): LiveStream {
    const live: LiveStream = { bridge: new WorkerStreamBridge(bytes => { live.unacked -= bytes; this.post({ kind: 'stream-ack', id, bytes }) }), unacked: 0, ended: false }
    live.bridge.on('error', () => undefined)
    const settle = (): void => {
      cleanup()
      if (live.ended) { if (live.unacked > 0) this.post({ kind: 'stream-cancel', id }); this.streams.delete(id) }
      else this.cancelStream(id)
    }
    live.bridge.once('end', settle); live.bridge.once('close', settle)
    this.streams.set(id, live)
    return live
  }
  private cancelStream(id: string): void {
    const live = this.streams.get(id)
    if (live === undefined || live.ended || live.cancelTimer !== undefined) return
    this.cancelledStreams += 1; this.post({ kind: 'stream-cancel', id })
    // Mark the timer before destroying: close listeners may run synchronously in custom consumers.
    live.cancelTimer = setTimeout(() => { if (!live.ended) void this.terminate('stream-cancel-unresponsive') }, this.limits.streamCancelGraceMs)
    live.cancelTimer.unref(); live.bridge.destroy()
  }
}

function responseMetadata(message: Record<string, unknown>): Omit<MobileRouteResponse, 'body'> {
  const headers: Record<string, string> = {}
  let bytes = typeof message.contentType === 'string' ? Buffer.byteLength(message.contentType) : 0
  if (message.headers !== undefined) {
    if (message.headers === null || typeof message.headers !== 'object' || Array.isArray(message.headers)) throw new Error('invalid response headers')
    const entries = Object.entries(message.headers)
    if (entries.length > 3) throw new Error('invalid response header count')
    for (const [key, value] of entries) {
      if (typeof value !== 'string' || !/^(?:content-disposition|cache-control|etag)$/iu.test(key)) throw new Error('invalid response header')
      bytes += Buffer.byteLength(key) + Buffer.byteLength(value)
      if (bytes > WORKER_RESPONSE_METADATA_MAX_BYTES) throw new Error('invalid response header bytes')
      headers[key] = value
    }
  }
  return { ...(typeof message.status === 'number' ? { status: message.status } : {}), ...(typeof message.contentType === 'string' ? { contentType: message.contentType } : {}), ...(message.headers === undefined ? {} : { headers }) }
}
/** Credit belongs to bytes actually removed by the consumer, including reads after source EOF. */
class WorkerStreamBridge extends Readable {
  constructor(private readonly consume: (bytes: number) => void) { super({ highWaterMark: 16 * 1024 }) }
  override _read(): void { /* The worker's credit window bounds incoming bytes. */ }
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    // Node emits data both for explicit read() and for a push() into a flowing pipeline.
    // Observing read() alone misses the latter and can permanently exhaust stream credit.
    if (event === 'data' && Buffer.isBuffer(args[0])) this.consume(args[0].byteLength)
    return super.emit(event, ...args)
  }
}
