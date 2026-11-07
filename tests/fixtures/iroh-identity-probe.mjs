/**
 * Controlled probe fixture for src/iroh.ts identity resolution.
 *
 * The parent must not report a failure while this process is still alive. On
 * POSIX the fixture records that SIGTERM arrived; on Windows a graceful signal
 * terminates the process outright, so the parent's evidence is the pid's
 * disappearance instead. Either way the fixture publishes its pid first, which
 * lets the test prove the parent awaited the real exit rather than assuming
 * kill() finished the job. It never touches the network or a real DSH profile.
 */
import { writeFileSync } from 'node:fs'

const mode = process.argv[2]
const marker = process.argv[3]

// Publish the pid before anything else so the test can check liveness even for
// modes that exit immediately.
writeFileSync(marker, String(process.pid))

if (mode === 'hang') {
  // Ignore SIGTERM so the parent must escalate to SIGKILL. Windows cannot
  // deliver a catchable SIGTERM, so there this behaves as a slow exit.
  process.on('SIGTERM', () => {
    writeFileSync(`${marker}.sigterm`, 'received')
    setTimeout(() => process.exit(0), 60_000)
  })
  setInterval(() => {}, 1_000)
} else if (mode === 'slow-exit') {
  process.on('SIGTERM', () => {
    setTimeout(() => { process.exit(0) }, 120)
  })
  setInterval(() => {}, 1_000)
} else if (mode === 'valid-id') {
  process.stdout.write(JSON.stringify({ version: 1, endpointId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' }) + '\n')
  process.exit(0)
} else if (mode === 'bad-id') {
  process.stdout.write('not-a-valid-endpoint-id\n')
  process.exit(0)
} else if (mode === 'huge-output') {
  // Exceed the bounded metadata reply; the parent must stop the probe.
  process.stdout.write('a'.repeat(16384))
  setInterval(() => {}, 1_000)
} else if (mode === 'exit-nonzero') {
  process.stdout.write('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n')
  process.exit(3)
} else if (mode === 'unsafe-directory') {
  process.stderr.write('private Windows data directory is not secure\nCaused by: private path ACL grants access or replacement rights to another principal\n')
  process.exit(3)
} else if (mode === 'invalid-utf8') {
  process.stdout.write(Buffer.from([0xff, 0xfe, 0xfd]))
  process.exit(0)
} else {
  process.stderr.write(`unknown mode ${String(mode)}\n`)
  process.exit(2)
}
