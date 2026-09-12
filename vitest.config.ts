import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup-env.ts'],
    // The suite exercises real transactions against one database, so files run
    // one at a time. Concurrency inside a test is the point; concurrency
    // between unrelated files would only make failures hard to attribute.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
