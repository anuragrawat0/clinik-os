import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * P9: the bootstrap CLI must expose exactly one diagnostic code on stderr for every failure exit,
 * and no URL, password, hash or stack trace. These cases fail before any database connection, so
 * they need no Testcontainer; the successful and connection-path exits are covered by
 * admin-bootstrap.int.spec.ts.
 */
const unreachable = 'postgresql://clinic_app:not-a-real-secret@127.0.0.1:1/none';

function run(args: string[], stdin: string, databaseUrl: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/create-admin.ts', ...args], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function expectOnlyCode(
  result: { code: number | null; stdout: string; stderr: string },
  expected: { code: number; stderr: string },
) {
  expect(result).toEqual({ code: expected.code, stdout: '', stderr: expected.stderr });
  for (const secret of ['not-a-real-secret', unreachable, '$argon2', 'at Object', 'Error:'])
    expect(`${result.stderr}${result.stdout}`).not.toContain(secret);
}

const validArgs = ['--email', 'bootstrap-review@clinik.test', '--name', 'Synthetic Reviewer'];

describe('admin:create failure exit codes', () => {
  it('exits 1 with USAGE for an unrecognized option', async () => {
    expectOnlyCode(await run(['--bogus', 'value'], '', unreachable), {
      code: 1,
      stderr: 'USAGE: admin:create --email <email> --name "<full name>"\n',
    });
  });

  it.each([
    ['missing arguments', []],
    ['invalid email', ['--email', 'not-an-email', '--name', 'Synthetic Reviewer']],
    ['blank name', ['--email', 'bootstrap-review@clinik.test', '--name', '   ']],
  ])('exits 1 with INVALID_EMAIL_OR_NAME for %s', async (_case, args) => {
    expectOnlyCode(await run(args, '', unreachable), {
      code: 1,
      stderr: 'INVALID_EMAIL_OR_NAME\n',
    });
  });

  it('exits 2 when no password is supplied on stdin', async () => {
    expectOnlyCode(await run(validArgs, '', unreachable), {
      code: 2,
      stderr: 'PASSWORD_MISSING_OR_CONFIRMATION_MISMATCH\n',
    });
  });

  it('exits 2 with DATABASE_URL_MISSING before reading a password', async () => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', 'src/cli/create-admin.ts', ...validArgs],
          { env: { ...process.env, DATABASE_URL: '' } },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end('Synthetic-passphrase-that-is-long-enough-1\n');
      },
    );
    expect(result).toEqual({ code: 2, stdout: '', stderr: 'DATABASE_URL_MISSING\n' });
  });
});
