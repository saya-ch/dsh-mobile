import { constants, type WriteStream } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { finished } from 'node:stream/promises'
import { join } from 'node:path'
import { Logger, type Context, type Exporter, type Message } from '@deepseek-ai/cordis'
import { assertManagedParents, ensureManagedDirectory, removeManagedTree, renameManagedPath } from './managed-files.js'
import { restrictPrivateFile } from './private-file.js'

const MAX_LOG_BYTES = 5 * 1024 * 1024
const MAX_QUEUED_BYTES = 256 * 1024
const PATH_PREFIX = 'mobile_log'

/** Stream acquisition seam used by owner-local I/O failure fixtures. */
export interface MobileFileLoggerOptions { readonly createStream?: (handle: FileHandle) => WriteStream }

async function regularLogFile(file: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    const entry = await lstat(file)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('mobile_log_target_invalid')
    return entry
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Open a private append-only file before registering a safely disposable Cordis exporter. */
export async function installMobileFileLogger(ctx: Context, stateDirectory: string, options: MobileFileLoggerOptions = {}): Promise<string> {
  const directory = join(stateDirectory, 'logs')
  const file = join(directory, 'dsh-mobile.log')
  const previous = `${file}.1`
  await ensureManagedDirectory(stateDirectory, directory, PATH_PREFIX)
  const entry = await regularLogFile(file)
  if (entry !== undefined && entry.size >= MAX_LOG_BYTES) {
    await regularLogFile(previous)
    await removeManagedTree(stateDirectory, previous, PATH_PREFIX)
    await renameManagedPath(stateDirectory, file, previous, PATH_PREFIX)
    await regularLogFile(previous)
    await restrictPrivateFile(previous)
  }
  await assertManagedParents(stateDirectory, file, PATH_PREFIX)
  await regularLogFile(file)
  const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600)
  let stream: WriteStream
  try {
    const opened = await handle.stat()
    const actual = await regularLogFile(file)
    if (!opened.isFile() || actual === undefined || actual.dev !== opened.dev || actual.ino !== opened.ino) throw new Error('mobile_log_target_invalid')
    await assertManagedParents(stateDirectory, file, PATH_PREFIX)
    await handle.chmod(0o600)
    await restrictPrivateFile(file)
    stream = options.createStream?.(handle) ?? handle.createWriteStream({ encoding: 'utf8', autoClose: true })
  } catch (error) { await handle.close(); throw error }

  let stopped = false
  let removeExporter: (() => Promise<void>) | undefined
  const stopLogging = (error: unknown): void => {
    if (stopped) return
    stopped = true
    try { void Promise.resolve(removeExporter?.()).catch(() => undefined) }
    catch (disposeError) { void disposeError /* This exporter is already gated against further writes. */ }
    stream.destroy()
    const candidate = error as { readonly code?: unknown } | null
    const code = candidate !== null && typeof candidate === 'object' && typeof candidate.code === 'string' ? candidate.code : 'write_failed'
    // This exporter is stopped first, so warning delivery cannot recursively write to the failed file.
    try { ctx.logger('dsh-mobile').warn('file logging disabled (%s); other logging remains available', code) }
    catch (loggerError) { void loggerError /* A diagnostic sink failure cannot crash DSH. */ }
  }
  stream.on('error', stopLogging)
  const closed = finished(stream, { cleanup: true }).catch(error => { stopLogging(error) })
  const exporter: Exporter = {
    colors: false,
    maxLength: 16 * 1024,
    levels: { default: -1, 'dsh-mobile': 3 },
    export(message: Message): void {
      if (stopped || message.name !== 'dsh-mobile') return
      try {
        const record = { timestamp: new Date(message.ts).toISOString(), level: message.type, logger: message.name, message: Logger.format(exporter, message) }
        const line = `${JSON.stringify(record)}\n`
        if (stream.writableLength + Buffer.byteLength(line) > MAX_QUEUED_BYTES) { stopLogging(Object.assign(new Error('file log queue exhausted'), { code: 'backpressure' })); return }
        stream.write(line)
      } catch (error) { stopLogging(error) }
    },
  }
  try {
    removeExporter = ctx.logger.exporter(exporter)
    ctx.effect(() => async () => {
      stopped = true
      await removeExporter?.()
      stream.end()
      await closed
    }, 'dsh-mobile file logger')
  } catch (error) {
    stopped = true; stream.destroy(); await closed
    await removeExporter?.()
    throw error
  }
  return file
}
