import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    alias: {
      'cloudflare:workers': './test/mocks/cloudflare-workers.ts',
    },
  },
});
