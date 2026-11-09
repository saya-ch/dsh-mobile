/**
 * Controlled lifecycle tests for the iroh identity probe.
 *
 * These run a real child process (tests/fixtures/iroh-identity-probe.mjs)
 * instead of a fake, because the defect under test is about the ordering
 * between a failure report and the probe's actual exit. A fake EventEmitter
 * can be told to close on cue; only a real process proves the parent waited.
 */
import { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultResolveIdentity, IrohIdentityProbeError } from '../src/iroh.js'

const probe = fileURLToPath(new URL('./fixtures/iroh-identity-probe.mjs', import.meta.url))
const ENDPOINT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const roots: string[] = []
const prefix = 'dsh-mobile-iroh-identity-'

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (root.startsWith(join(tmpdir(), prefix))) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

async function ownedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** Launch the fixture in `mode`, ignoring the sidecar argv the probe would receive. */
function launch(mode: string, marker: string) {
  // stdio uses pipes (not 'ignore') so the result matches the production
  // ChildProcessWithoutNullStreams shape the controller's launcher seam expects.
  return (_executable: string, _args: readonly string[]) => spawn(process.execPath, [probe, mode, marker], {
    stdio: ['pipe', 'pipe', 'pipe'] as const,
    windowsHide: true,
  })
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false)
}

/** Read the pid the fixture published before doing anything else. */
async function publishedPid(marker: string): Promise<number> {
  return Number((await readFile(marker, 'utf8')).trim())
}

/**
 * Check whether a pid is still running. `process.kill(pid, 0)` only probes
 * existence; on Windows a terminated pid may linger briefly as a zombie for
 * an already-reaped child, so this is used as a "must eventually be gone"
 * observation rather than an instantaneous one.
 */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Poll until the pid disappears; a single sample can race a still-closing process. */
async function waitUntilGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (alive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

describe('iroh identity probe lifecycle', () => {
  it('reports a failed termination instead of claiming a stopped probe', async () => {
    const root = await ownedRoot()
    const child = new ChildProcess()
    const stdout = new EventEmitter()
    Object.defineProperty(child, 'stdout', { value: stdout })
    child.kill = () => { throw new Error('controlled termination failure') }
    const outcome = defaultResolveIdentity('sidecar', root, {
      launch: () => child as never,
      timeoutMs: 5_000,
    }).catch((error: unknown) => error)
    stdout.emit('data', Buffer.alloc(8193))
    const failure = await outcome
    child.emit('close', 0, null)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message).toBe('iroh_identity_cleanup_failed')
  })

  it('returns the verified endpoint id of a successful probe', async () => {
    const root = await ownedRoot()
    const marker = join(root, 'pid')
    const launcher = launch('valid-id', marker)
    await expect(defaultResolveIdentity('sidecar', root, { launch: (file, args) => {
      expect(args).toEqual(['--lang', 'en', 'tls-prepare', '--data-dir', root])
      return launcher(file, args)
    } })).resolves.toBe(ENDPOINT)
    expect(alive(await publishedPid(marker))).toBe(false)
  })

  it('distinguishes malformed metadata from a failed probe', async () => {
    const root = await ownedRoot()
    for (const mode of ['bad-id', 'invalid-utf8']) {
      await expect(defaultResolveIdentity('sidecar', root, { launch: launch(mode, join(root, `pid-${mode}`)) }))
        .rejects.toThrow('iroh_identity_invalid')
    }
    await expect(defaultResolveIdentity('sidecar', root, { launch: launch('exit-nonzero', join(root, 'pid-exit-nonzero')) }))
      .rejects.toThrow('iroh_identity_invalid')
  })

  it('classifies an unsafe Windows profile and retains the native explanation', async () => {
    const root = await ownedRoot()
    const failure = await defaultResolveIdentity('sidecar', root, {
      launch: launch('unsafe-directory', join(root, 'pid-unsafe-directory')),
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(IrohIdentityProbeError)
    expect(failure).toMatchObject({
      code: 'iroh_data_directory_insecure',
      diagnostic: expect.stringContaining('private path ACL grants access or replacement rights to another principal'),
    })
  })

  it('uses the local-only host cause chain when tls-prepare hides the native explanation', async () => {
    const root = await ownedRoot()
    const marker = join(root, 'pid-generic-tls-failure')
    const failure = await defaultResolveIdentity('sidecar', root, {
      launch: (_executable, args) => spawn(process.execPath, [
        probe,
        args.includes('tls-prepare') ? 'generic-tls-failure' : 'host-unsafe-directory',
        marker,
      ], { stdio: ['pipe', 'pipe', 'pipe'] as const, windowsHide: true }),
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(IrohIdentityProbeError)
    expect(failure).toMatchObject({
      code: 'iroh_data_directory_insecure',
      diagnostic: expect.stringContaining('private path ACL grants access or replacement rights to another principal'),
    })
  })

  it('recognizes the wrapper when the sidecar ends its stderr line with CRLF', async () => {
    const root = await ownedRoot()
    const marker = join(root, 'pid-crlf')
    const failure = await defaultResolveIdentity('sidecar', root, {
      launch: (_executable, args) => spawn(process.execPath, [
        probe,
        args.includes('tls-prepare') ? 'generic-tls-failure-crlf' : 'host-unsafe-directory',
        marker,
      ], { stdio: ['pipe', 'pipe', 'pipe'] as const, windowsHide: true }),
    }).catch((error: unknown) => error)
    // Windows-native tooling emits CRLF; a bare wrapper must still be expanded
    // by the local-only host probe instead of being reported verbatim.
    expect(failure).toMatchObject({
      code: 'iroh_data_directory_insecure',
      diagnostic: expect.stringContaining('private path ACL grants access or replacement rights to another principal'),
    })
  })

  it('recognizes the wrapper when an unrelated diagnostic line precedes it', async () => {
    const root = await ownedRoot()
    const marker = join(root, 'pid-prefixed')
    const failure = await defaultResolveIdentity('sidecar', root, {
      launch: (_executable, args) => spawn(process.execPath, [
        probe,
        args.includes('tls-prepare') ? 'generic-tls-failure-prefixed' : 'host-unsafe-directory',
        marker,
      ], { stdio: ['pipe', 'pipe', 'pipe'] as const, windowsHide: true }),
    }).catch((error: unknown) => error)
    // The wrapper is still the only explanation for the failure, so a prefix
    // such as a warning must not swallow the local-only host's cause chain.
    expect(failure).toMatchObject({
      code: 'iroh_data_directory_insecure',
      diagnostic: expect.stringContaining('private path ACL grants access or replacement rights to another principal'),
    })
  })

  it('does not rerun the host for an unrelated tls-prepare failure', async () => {
    const root = await ownedRoot()
    const marker = join(root, 'pid-unrelated')
    const failure = await defaultResolveIdentity('sidecar', root, {
      launch: (_executable, args) => spawn(process.execPath, [
        probe,
        args.includes('tls-prepare') ? 'unrelated-failure' : 'host-unsafe-directory',
        marker,
      ], { stdio: ['pipe', 'pipe', 'pipe'] as const, windowsHide: true }),
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: 'iroh_identity_invalid',
      diagnostic: expect.stringContaining('cannot open profile lock'),
    })
    // The fallback host advertises itself; its marker must not exist, or an
    // unrelated error would be reclassified by a second, unrelated probe.
    expect(await exists(`${marker}.host`)).toBe(false)
  })

  it('bounds the fallback diagnostic and terminates the host it started', async () => {
    const root = await ownedRoot()
    const marker = join(root, 'pid-host-hang')
    const started = Date.now()
    const failure = await defaultResolveIdentity('sidecar', root, {
      launch: (_executable, args) => spawn(process.execPath, [
        probe,
        args.includes('tls-prepare') ? 'generic-tls-failure' : 'host-hang',
        marker,
      ], { stdio: ['pipe', 'pipe', 'pipe'] as const, windowsHide: true }),
    }).catch((error: unknown) => error)
    const elapsed = Date.now() - started
    expect(failure).toMatchObject({ code: 'iroh_identity_invalid' })
    // The fallback spends its own bounded budget, so the whole failure has to
    // surface after that budget instead of waiting forever on an idle host.
    expect(elapsed).toBeGreaterThanOrEqual(5_000)
    expect(elapsed).toBeLessThan(15_000)
    const hostPid = await publishedPid(`${marker}.host`)
    await waitUntilGone(hostPid)
    expect(alive(hostPid)).toBe(false)
  }, 30_000)

  it('closes stdin for the fallback host so it cannot idle forever', async () => {
    const root = await ownedRoot()
    const marker = join(root, 'pid-host-stdin')
    const started = Date.now()
    const failure = await defaultResolveIdentity('sidecar', root, {
      launch: (_executable, args) => spawn(process.execPath, [
        probe,
        args.includes('tls-prepare') ? 'generic-tls-failure' : 'host-wait-stdin',
        marker,
      ], { stdio: ['pipe', 'pipe', 'pipe'] as const, windowsHide: true }),
    }).catch((error: unknown) => error)
    // host-wait-stdin only reports its cause after stdin reaches EOF, which the
    // coordinator performs. Without that close this would burn the 5s budget.
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(failure).toMatchObject({
      code: 'iroh_data_directory_insecure',
      diagnostic: expect.stringContaining('private path ACL grants access or replacement rights to another principal'),
    })
    await waitUntilGone(await publishedPid(`${marker}.host`))
  }, 20_000)

  it('truncates an oversized stderr diagnostic instead of buffering it', async () => {
    const root = await ownedRoot()
    const failure = await defaultResolveIdentity('sidecar', root, {
      launch: launch('oversized-stderr', join(root, 'pid-oversized-stderr')),
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(IrohIdentityProbeError)
    expect((failure as IrohIdentityProbeError).code).toBe('iroh_identity_invalid')
    expect((failure as IrohIdentityProbeError).diagnostic).toHaveLength(4_096)
  })

  it('does not report a timeout before the probe has actually exited', async () => {
    const root = await ownedRoot()
    const marker = join(root, 'pid')
    const started = Date.now()
    // The fixture stays alive until it is signalled. A parent that rejected on
    // its timer alone would return while this pid was still running. The
    // deadline is well past Node's own startup so the fixture has published
    // its pid before the timer fires.
    await expect(defaultResolveIdentity('sidecar', root, {
      launch: launch('hang', marker),
      timeoutMs: 500,
    })).rejects.toThrow('iroh_identity_timeout')
    const pid = await publishedPid(marker)
    // The rejection is only published after terminateRemoteProcess observed the
    // real close event, so the process must already be gone at this point.
    expect(alive(pid)).toBe(false)
    // The deadline itself elapsed before the failure surfaced; escalation can
    // only add to that. On POSIX the graceful window adds ~1.5s, while Windows
    // terminates on the signal, so only the deadline bound is portable.
    expect(Date.now() - started).toBeGreaterThanOrEqual(500)
  }, 20_000)

  it('waits for a probe that exits late instead of abandoning it', async () => {
    const root = await ownedRoot()
    const marker = join(root, 'pid')
    await expect(defaultResolveIdentity('sidecar', root, {
      launch: launch('slow-exit', marker),
      timeoutMs: 500,
    })).rejects.toThrow('iroh_identity_timeout')
    // Whatever the platform's signal semantics, the pid must be gone by the
    // time the parent rejects: no probe outlives the failure it reported.
    expect(alive(await publishedPid(marker))).toBe(false)
  }, 20_000)

  it('stops a probe that exceeds the output budget instead of buffering it', async () => {
    const root = await ownedRoot()
    const marker = join(root, 'pid')
    await expect(defaultResolveIdentity('sidecar', root, {
      launch: launch('huge-output', marker),
      timeoutMs: 5_000,
    })).rejects.toThrow('iroh_identity_output_too_large')
    expect(alive(await publishedPid(marker))).toBe(false)
  }, 20_000)

  it('rejects a spawn failure without waiting for a process that never existed', async () => {
    const root = await ownedRoot()
    await expect(defaultResolveIdentity(join(root, 'missing-sidecar'), root, { timeoutMs: 5_000 }))
      .rejects.toThrow('iroh_identity_failed')
  })

  // A real child cannot distinguish the two implementations on Windows, where
  // a graceful signal terminates the process outright. This controlled child
  // makes the ordering observable on every platform: the promise must stay
  // pending until the close event arrives, however late that is. The previous
  // implementation rejected on its timer while this child was still running.
  it('keeps the failure pending until the controlled child actually closes', async () => {
    const root = await ownedRoot()
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { resume: () => void }
      stderr: EventEmitter & { resume: () => void }
      stdin: { write: () => boolean; on: () => void }
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      kill: (signal?: NodeJS.Signals) => boolean
    }
    const stdout = Object.assign(new EventEmitter(), { resume: () => {} })
    const stderr = Object.assign(new EventEmitter(), { resume: () => {} })
    child.stdout = stdout
    child.stderr = stderr
    child.stdin = { write: () => true, on: () => {} }
    child.exitCode = null
    child.signalCode = null
    let killed: NodeJS.Signals | undefined
    child.kill = (signal?: NodeJS.Signals) => {
      killed = signal
      // Deliberately do not emit close here: the child is "still shutting down".
      return true
    }
    let settled: 'pending' | 'rejected' = 'pending'
    const outcome = defaultResolveIdentity('sidecar', root, {
      launch: () => child as never,
      timeoutMs: 30,
    }).catch((error: Error) => { settled = 'rejected'; throw error })
    // Give the timer more than enough time to fire and the parent a chance to
    // settle early if it were going to.
    await new Promise(resolve => setTimeout(resolve, 250))
    expect(killed).toBe('SIGTERM')
    // The critical assertion: still pending because the child has not closed.
    expect(settled).toBe('pending')
    // Now let the graceful timer escalate and the close event arrive.
    child.exitCode = 0
    child.emit('close', 0, null)
    await expect(outcome).rejects.toThrow('iroh_identity_timeout')
    expect(settled).toBe('rejected')
  }, 20_000)
})
