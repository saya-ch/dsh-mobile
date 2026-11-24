import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The question-fixes component is its own package, so its tests live beside it.
    include: ['tests/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // These suites are dominated by real sockets, TLS handshakes and child
    // processes rather than CPU, so running files concurrently is close to free:
    // the whole suite drops from ~297s serial to ~82s on four workers. Four is
    // deliberate rather than "as many as possible": some suites still call
    // `spawnSync`, which blocks its worker's event loop and starves timers in the
    // files sharing it, and that showed up as a random flake above four workers
    // (three consecutive four-worker runs were clean). Raise this only after
    // those blocking calls become async. `--maxWorkers` on the command line wins.
    pool: 'threads',
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
      reporter: ['text', 'json-summary'],
    },
  },
})
