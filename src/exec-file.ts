import { execFile, type ExecFileOptions } from 'node:child_process'

/**
 * Longest stream text attached to a failed subprocess result.
 *
 * The text exists for diagnostics only: a caller decides which part is safe to
 * show. It is bounded here so a chatty child cannot turn one failure into an
 * unbounded buffer in every future consumer of that rejection.
 */
export const MAX_SUBPROCESS_ERROR_STREAM_CHARS = 8 * 1024

function boundedStream(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return value.length <= MAX_SUBPROCESS_ERROR_STREAM_CHARS
    ? value
    : value.slice(0, MAX_SUBPROCESS_ERROR_STREAM_CHARS)
}

/**
 * Attach the captured streams to a subprocess failure, best effort.
 *
 * `execFile` reports a non-zero exit as an Error whose only text is the command
 * line with stderr merged into `message`; the raw stream strings are handed to
 * the callback and otherwise discarded, so a caller cannot read them from the
 * rejection. They are copied onto it when it accepts properties. A frozen,
 * exotic or primitive rejection value must keep `message` as its diagnostic
 * rather than turn one failure into a different error, so every write is
 * guarded and an existing property is never overwritten.
 */
function attachCapturedStreams(error: unknown, stdout: unknown, stderr: unknown): void {
  if (typeof error !== 'object' || error === null) return
  const target = error as { stdout?: unknown; stderr?: unknown }
  try {
    const capturedStderr = boundedStream(stderr)
    const capturedStdout = boundedStream(stdout)
    if (target.stderr === undefined && capturedStderr !== undefined) target.stderr = capturedStderr
    if (target.stdout === undefined && capturedStdout !== undefined) target.stdout = capturedStdout
  } catch {
    // A non-extensible error keeps `error.message` as its only diagnostic.
  }
}

/** Capture both output streams even when a desktop host wraps execFile without Node's promisify metadata. */
export function execFileText(
  file: string,
  args: readonly string[],
  options: Omit<ExecFileOptions, 'encoding'> & { encoding?: 'utf8' } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { windowsHide: true, ...options, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) { attachCapturedStreams(error, stdout, stderr); reject(error); return }
      if (typeof stdout !== 'string' || typeof stderr !== 'string') {
        reject(new Error('subprocess returned invalid text output'))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}
