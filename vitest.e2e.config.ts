import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.spec.ts'],
    clearMocks: true,
    testTimeout: 120_000,
  },
});
