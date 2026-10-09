/** A native capability call belongs to the extension that queued it. */
export interface BoundNativeCapabilityBridge {
  invoke(action: string, input?: unknown): Promise<unknown>
}

/** Cancel queued calls before native effects start; started effects are not rolled back. */
export function invokeBoundNativeCapability(
  bridge: BoundNativeCapabilityBridge,
  currentBridge: () => BoundNativeCapabilityBridge | undefined,
  action: string,
  input: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const abortReason = (): unknown => signal.reason ?? new DOMException('mobile extension disposed', 'AbortError')
  if (signal.aborted) return Promise.reject(abortReason())
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => { finish(() => { reject(abortReason()) }) }
    signal.addEventListener('abort', onAbort, { once: true })
    void Promise.resolve().then(() => {
      if (settled || signal.aborted) throw abortReason()
      if (currentBridge() !== bridge) throw new DOMException('native bridge changed', 'AbortError')
      return bridge.invoke(action, input)
    }).then(value => { finish(() => { resolve(value) }) }, error => { finish(() => { reject(error) }) })
  })
}
