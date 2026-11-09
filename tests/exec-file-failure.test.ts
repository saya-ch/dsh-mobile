import { describe, expect, it } from 'vitest'
import { execFileText, MAX_SUBPROCESS_ERROR_STREAM_CHARS } from '../src/exec-file.js'

/**
 * Real child processes, unmocked: the desktop-compatibility contract in
 * `exec-file.test.ts` mocks `node:child_process`, so it cannot observe what a
 * genuine non-zero exit hands to the callback.
 */
function run(source: string): Promise<{ stdout: string; stderr: string }> {
  return execFileText(process.execPath, ['-e', source])
}

describe('execFileText failure detail', () => {
  it('hands the captured streams to the caller instead of discarding them', async () => {
    const failure = await run("process.stderr.write('boom-from-child'); process.exit(7)")
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    // Node reports a non-zero exit as a numeric code; both parts must survive.
    expect(failure).toMatchObject({ code: 7, stderr: 'boom-from-child' })
    expect('stderr' in (failure as object)).toBe(true)
  })

  it('attaches captured stdout when the child wrote one', async () => {
    const failure = await run("process.stdout.write('partial-output'); process.exit(2)")
      .catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 2, stdout: 'partial-output' })
  })

  it('does not add properties for streams the child never produced', async () => {
    const failure = await run('process.exit(3)').catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: 3 })
    expect('stderr' in (failure as object)).toBe(false)
    expect('stdout' in (failure as object)).toBe(false)
  })

  it('bounds a chatty failure stream so one error cannot become an unbounded buffer', async () => {
    const failure = await run("process.stderr.write('x'.repeat(20000)); process.exit(4)")
      .catch((error: unknown) => error)

    const stderr = (failure as { stderr?: string }).stderr
    expect(stderr).toHaveLength(MAX_SUBPROCESS_ERROR_STREAM_CHARS)
    expect(stderr?.startsWith('xxxx')).toBe(true)
  })

  it('keeps the success contract for a zero exit', async () => {
    await expect(run("process.stdout.write('ok'); process.stderr.write('note')"))
      .resolves.toEqual({ stdout: 'ok', stderr: 'note' })
  })
})
