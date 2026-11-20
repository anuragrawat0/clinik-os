import { ESLint } from 'eslint';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(process.cwd(), '../..');
const handlerPath = resolve(repositoryRoot, 'apps/api/src/core/jobs/handlers/example.handler.ts');

async function lintHandler(source: string): Promise<readonly { ruleId: string | null }[]> {
  const eslint = new ESLint({ cwd: repositoryRoot });
  const [result] = await eslint.lintText(source, { filePath: handlerPath });
  return result.messages;
}

describe('job handler database boundary', () => {
  it('rejects direct imports of the transaction helper', async () => {
    const messages = await lintHandler(
      `import { withTenantTransaction } from '../../db/transaction-context';\nexport const handler = withTenantTransaction;\n`,
    );
    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it('rejects direct imports of a raw database client', async () => {
    const messages = await lintHandler(
      `import { Pool } from 'pg';\nexport const pool = new Pool();\n`,
    );
    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
  });

  it('rejects importing pg-boss or drizzle from a handler', async () => {
    const messages = await lintHandler(
      `import { PgBoss } from 'pg-boss';\nimport { sql } from 'drizzle-orm';\nexport const value = { PgBoss, sql };\n`,
    );
    const restricted = messages.filter((message) => message.ruleId === 'no-restricted-imports');
    expect(restricted).toHaveLength(2);
  });

  it('allows handlers to use runInTenant', async () => {
    const messages = await lintHandler(
      `import { runInTenant } from '../run-in-tenant';\nexport const handler = runInTenant;\n`,
    );
    expect(messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(false);
  });
});
