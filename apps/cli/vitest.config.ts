import { configDefaults, defineConfig } from 'vitest/config'

/**
 * The default run is the fast unit suite. Integration tests spawn the real
 * CLI entrypoint through tsx and take about a second each, which is too slow
 * to sit in the loop developers run constantly — they live in
 * `vitest.integration.config.ts` behind `npm run test:integration`.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
})
