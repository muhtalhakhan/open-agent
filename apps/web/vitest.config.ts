import { defineConfig } from 'vitest/config'

/**
 * Present so Vitest does not pick up vite.config.ts, whose `root` is the
 * client directory and would hide the server's tests.
 */
export default defineConfig({
  test: {},
})
