import { defineConfig } from 'vitest/config'

/**
 * Tests that drive the real CLI as a user would: spawned process, piped
 * stdin, a fake provider on a socket. Slower than the unit suite and run
 * separately (`npm run test:integration`), but they cover `src/index.ts`,
 * which nothing else does.
 */
export default defineConfig({
  test: {
    include: ['**/*.integration.test.ts'],
    // A spawned tsx process plus a fake HTTP server needs more headroom than
    // the 5s default, especially on a cold CI runner.
    testTimeout: 30_000,
  },
})
