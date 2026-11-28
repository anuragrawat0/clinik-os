import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts'],
    exclude: [
      ...configDefaults.exclude,
      '**/*.pw.spec.ts',
      '**/test/auth-form-security.spec.ts',
      '**/test/audit/security-headers.spec.ts',
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    clearMocks: true,
  },
});
