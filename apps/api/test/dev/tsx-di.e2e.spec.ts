import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `pnpm start:dev` runs under tsx/esbuild, which does not emit decorator metadata, so every
 * constructor parameter needs an explicit @Inject(...). Vitest does emit metadata and cannot catch
 * a missing one; this boots the real AppModule under tsx.
 */
describe('real AppModule under tsx (no decorator metadata)', () => {
  let child: ChildProcessWithoutNullStreams;
  let base: string;
  let stderr = '';

  beforeAll(async () => {
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
    child = spawn(
      process.execPath,
      [tsxCli, '--tsconfig', 'test/tsconfig.json', 'test/dev/probe-main.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: 'postgresql://clinic_app:test@127.0.0.1:1/none',
          LOG_LEVEL: 'fatal',
        },
      },
    );
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`tsx probe timed out. ${stderr}`)), 90_000);
      child.stdout.on('data', (chunk: Buffer) => {
        const match = /LISTENING (\d+)/.exec(chunk.toString());
        if (match) {
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${match[1]}`);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`tsx probe exited ${code}. ${stderr}`));
      });
    });
  }, 120_000);

  afterAll(() => {
    child?.removeAllListeners('exit');
    child?.kill();
  });

  it('serves the public health route', async () => {
    const response = await fetch(`${base}/api/v1/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', database: 'ok' });
  });

  it('the guarded probe answers 401 without a session (SessionGuard is wired and injected)', async () => {
    const response = await fetch(`${base}/api/v1/__probe/secure`);
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe('UNAUTHENTICATED');
  });

  it('a dead session cookie is also 401 and is cleared', async () => {
    const response = await fetch(`${base}/api/v1/__probe/secure`, {
      headers: { cookie: '__Host-session=stale' },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toContain('__Host-session=;');
  });

  it('CsrfGuard is wired: a POST without the header is 403, with it the session guard answers 401', async () => {
    const without = await fetch(`${base}/api/v1/__probe/secure`, { method: 'POST' });
    expect(without.status).toBe(403);
    const withHeader = await fetch(`${base}/api/v1/__probe/secure`, {
      method: 'POST',
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    expect(withHeader.status).toBe(401);
  });
});
