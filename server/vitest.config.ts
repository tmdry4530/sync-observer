import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each suite boots a throwaway embedded Postgres cluster, so give them room
    // and keep them serial to avoid spinning up many clusters at once.
    testTimeout: 60_000,
    hookTimeout: 90_000,
    fileParallelism: false,
    pool: 'forks'
  }
})
