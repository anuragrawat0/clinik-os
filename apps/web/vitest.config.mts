import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The web unit suite runs as part of the root `pnpm test`. To run it on its own:
 *
 *   pnpm --filter @clinik/web test
 */
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['test/unit/**/*.{spec,test}.{ts,tsx}'],
    environment: 'node',
  },
});
