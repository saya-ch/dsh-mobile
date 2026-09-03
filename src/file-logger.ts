import { createWriteStream, type WriteStream } from 'node:fs'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Logger, type Context, type Exporter, type Message } from '@deepseek-ai/cordis'

const MAX_LOG_BYTES = 5 * 1024 * 1024

/** Install a plugin-scoped Cordis exporter backed by a private UTF-8 log file. */
export async function installMobileFileLogger(ctx: Context, stateDirectory: string): Promise<string> {
  const directory = join(stateDirectory, 'logs')
  const file = join(directory, 'dsh-mobile.log')
  const previous = `${file}.1`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const entry = await lstat(file).catch(() => undefined)
  if (entry !== undefined && entry.isFile() && !entry.isSymbolicLink() && entry.size >= MAX_LOG_BYTES) {
    await rm(previous, { force: true })
    await rename(file, previous)
  }
  const stream: WriteStream = createWriteStream(file, { flags: 'a', encoding: 'utf8', mode: 0o600 })
  const exporter: Exporter = {
    colors: false,
    maxLength: 16 * 1024,
    levels: { default: -1, 'dsh-mobile': 3 },
    export(message: Message): void {
      if (message.name !== 'dsh-mobile') return
      const record = {
        timestamp: new Date(message.ts).toISOString(),
        level: message.type,
        logger: message.name,
        message: Logger.format(exporter, message),
      }
      stream.write(`${JSON.stringify(record)}\n`)
    },
  }
  ctx.logger.exporter(exporter)
  ctx.effect(() => () => { stream.end() }, 'dsh-mobile file logger')
  return file
}
