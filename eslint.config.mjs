import js from '@eslint/js';
import nextVitals from 'eslint-config-next/core-web-vitals';
import prettier from 'eslint-config-prettier/flat';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/.next/**', '**/coverage/**', '**/openapi.json'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...nextVitals,
  prettier,
  {
    settings: { react: { version: '19.2' } },
    rules: { '@next/next/no-html-link-for-pages': 'off' },
  },
  {
    files: ['apps/api/src/core/jobs/handlers/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/core/db',
                '**/core/db/**',
                '**/db',
                '**/db/**',
                '**/database.module',
                'pg',
                'pg/**',
                'pg-boss',
                'pg-boss/**',
                'drizzle-orm',
                'drizzle-orm/**',
              ],
              message:
                'Job handlers must access tenant data only through runInTenant; direct database clients and transaction helpers are not allowed.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      'no-undef': 'off',
    },
  },
);
