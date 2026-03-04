import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    globals: true,
    environmentMatchGlobs: [
      // API route tests run in node so Next.js server mocks work correctly
      ['test/api/**', 'node']
    ]
  },
  resolve: {
    alias: {
      '@claw/contracts': resolve(__dirname, '../../packages/contracts/src/index.ts'),
      '@claw/utils': resolve(__dirname, '../../packages/utils/src/index.ts')
    }
  }
});
