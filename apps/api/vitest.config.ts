import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true
      }
    },
    fileParallelism: false
  },
  resolve: {
    alias: {
      '@claw/contracts': resolve(__dirname, '../../packages/contracts/src/index.ts'),
      '@claw/utils': resolve(__dirname, '../../packages/utils/src/index.ts')
    }
  }
});
