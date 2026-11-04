/**
 * Reports whether this process already holds the macOS Full Disk Access grant.
 *
 * macOS shows a folder authorization dialog the first time a process reads a
 * protected location (Desktop, Documents, Downloads, external or network
 * volumes). While that dialog waits for a click, the calling thread stays
 * blocked, so an unattended machine can stall every request that needs the
 * file system. Granting Full Disk Access removes that class of dialog.
 *
 * The probe reads the per-user TCC database. That file is itself protected by
 * TCC, so opening it succeeds only for a process macOS already trusts with
 * Full Disk Access; a denied read fails immediately with EACCES/EPERM because
 * the grant can only be made in System Settings and can never be requested
 * through a dialog. The probe therefore never blocks on user input, unlike
 * reading one of the protected folders themselves.
 */

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

/** Result of the permission probe. */
export type MacFileAccessStatus = 'ok' | 'missing'

/** A final `ok` is sticky; only a non-ok result is retried, at most this often. */
const DEFAULT_RETRY_MS = 2_000

/** A probe that never settles is treated as missing rather than awaited forever. */
const DEFAULT_TIMEOUT_MS = 2_000

/** Options that let tests drive the probe without touching the real database. */
export interface MacFileAccessOptions {
  /** Platform override; only `darwin` performs a real probe. */
  readonly platform?: NodeJS.Platform
  /** Home directory override. */
  readonly home?: string
  /** Access check override; resolves when the database is readable. */
  readonly readAccess?: (path: string) => Promise<void>
  /** Clock override, in milliseconds. */
  readonly now?: () => number
  /** Minimum delay between two non-ok probes. */
  readonly retryMs?: number
  /** Upper bound on a single probe. */
  readonly timeoutMs?: number
}

/**
 * Caches the Full Disk Access state so a status response can read it
 * synchronously while the file system check stays asynchronous.
 */
export class MacFileAccessProbe {
  private readonly platform: NodeJS.Platform
  private readonly home: string
  private readonly readAccess: (path: string) => Promise<void>
  private readonly now: () => number
  private readonly retryMs: number
  private readonly timeoutMs: number
  private statusValue: MacFileAccessStatus = 'missing'
  private checkedAt = Number.NEGATIVE_INFINITY

  constructor(options: MacFileAccessOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.home = options.home ?? homedir()
    this.readAccess = options.readAccess ?? (path => access(path, constants.R_OK))
    this.now = options.now ?? Date.now
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Whether the probe applies to this platform at all. */
  get applicable(): boolean {
    return this.platform === 'darwin'
  }

  /** Latest cached result. Never performs I/O. */
  status(): MacFileAccessStatus {
    return this.applicable ? this.statusValue : 'ok'
  }

  /**
   * Refresh the cached result when it is not final yet.
   * @returns The result after this call.
   */
  async refresh(): Promise<MacFileAccessStatus> {
    if (!this.applicable) return 'ok'
    if (this.statusValue === 'ok') return 'ok'
    const at = this.now()
    if (at - this.checkedAt < this.retryMs) return this.statusValue
    this.checkedAt = at
    this.statusValue = await this.probe()
    return this.statusValue
  }

  /** Run one bounded access check and collapse every failure into `missing`. */
  private async probe(): Promise<MacFileAccessStatus> {
    const database = join(this.home, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.readAccess(database),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('macos_file_access_probe_timeout')), this.timeoutMs)
          // A pending probe must not keep the process alive.
          timer.unref?.()
        }),
      ])
      return 'ok'
    } catch {
      return 'missing'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/** System Settings deep link for the Full Disk Access pane. */
export const MAC_FULL_DISK_ACCESS_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'

const execFileAsync = promisify(execFile)

/**
 * Open the Full Disk Access pane from the host process.
 *
 * The desktop app's renderer refuses to navigate to a custom scheme, so the
 * button cannot use `window.open`; `open` runs on the Mac that owns the app.
 * @param run - Command runner, injectable for tests.
 */
export async function openMacFullDiskAccessSettings(
  run: (file: string, args: readonly string[]) => Promise<unknown> = execFileAsync as never,
): Promise<void> {
  await run('open', [MAC_FULL_DISK_ACCESS_PANE])
}
