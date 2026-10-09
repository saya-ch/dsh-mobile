import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildExtensionWorkerArtifacts } from './helpers/extension-worker-build.js'

/**
 * The blocking scenarios must run in a separately supervised process: the main
 * suite runs --pool=threads --maxWorkers=1, and a regression that wedged the
 * parent would otherwise hang the whole suite. Here the vitest test only
 * supervises the runner with a hard timeout and asserts its JSON verdict.
 */
describe('supervised extension worker blocking scenarios', () => {
  it('keeps the parent responsive, times the caller out, terminates and recovers', async () => {
    const artifacts = await buildExtensionWorkerArtifacts()
    const verdict = await new Promise<{ stdout: string; code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }>((resolve, reject) => {
      const child = spawn(process.execPath, ['tests/supervised/extension-worker-blocking-runner.mjs', artifacts.runtimeEntry, artifacts.supervisorBundle], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { process.stderr.write(chunk) })
      // Hard supervision: a wedged runner fails the test instead of the suite.
      let timedOut = false
      const guard = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 15_000)
      child.once('error', reject)
      child.once('close', (code, signal) => { clearTimeout(guard); resolve({ stdout, code, signal, timedOut }) })
    })
    expect(verdict.timedOut).toBe(false)
    expect(verdict.signal).toBeNull()
    expect(verdict.code).toBe(0)
    const report = JSON.parse(verdict.stdout) as {
      scenarioA: { responsive: boolean; timeout: boolean; terminated: boolean; recovered: boolean; runtimeRotated: boolean }
      scenarioB: { streamCancelled: boolean; terminated: boolean }
    }
    // Scenario A: synchronously blocking action.
    expect(report.scenarioA.responsive).toBe(true)
    expect(report.scenarioA.timeout).toBe(true)
    expect(report.scenarioA.terminated).toBe(true)
    expect(report.scenarioA.recovered).toBe(true)
    expect(report.scenarioA.runtimeRotated).toBe(true)
    // Scenario B: worker blocked while a stream is open; cancel → grace → terminate.
    expect(report.scenarioB.streamCancelled).toBe(true)
    expect(report.scenarioB.terminated).toBe(true)
  }, 25_000)
})
