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
    // the whole suite drops from ~296s serial to ~82s on four workers.
    //
    // Isolation stays on (Vitest's default), so every test file gets its own fresh
    // worker: a `spawnSync` can only stall the file that calls it, never another
    // file's timers. Four is still deliberate rather than "as many as possible",
    // because above four the child processes those suites spawn start missing
    // their own fixed budgets — under eight-way load `spawnSync ... ETIMEDOUT`
    // fired in tests/dsh-compatibility-contract.test.ts, which allows 5s per call,
    // and two of five runs failed there. Raise this only after those blocking
    // calls become async or get load-tolerant budgets. Note that Vitest enforces
    // testTimeout with a timer inside the worker, so a synchronous block cannot
    // even be interrupted by it. `--maxWorkers` on the command line wins.
    pool: 'threads',
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      // Only product source counts. The Android app, the Windows client and the
      // bundled sidecars have their own lanes and their own build artefacts;
      // counting them here would report them as uncovered product code forever.
      include: ['src/**/*.ts', 'packages/*/src/**/*.ts'],
      // `lcov` is what Codecov ingests; `json-summary` is what a local run or a
      // script can read without parsing the table. `text` stays for humans.
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
})
