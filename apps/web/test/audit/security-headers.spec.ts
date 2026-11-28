import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';

/**
 * Audit 2026-11-28 (B5). Runs against a live stack: SMOKE_WEB_URL (default http://127.0.0.1:3000).
 * ARCHITECTURE §7 "Headers" requires CSP, nosniff and a referrer policy; none of the pages send them.
 */
const web = new URL(process.env.SMOKE_WEB_URL ?? 'http://127.0.0.1:3000').origin;
const pages = [
  '/login',
  '/forgot-password',
  '/app',
  '/admin/organizations',
  '/o/any/settings/members',
];

for (const path of pages) {
  test(`${path} sends anti-framing, nosniff and no framework banner`, async ({ request }) => {
    const response = await request.get(web + path, { maxRedirects: 0 });
    const headers = response.headers();
    const csp = headers['content-security-policy'] ?? '';
    expect(
      /frame-ancestors\s+('none'|'self')/.test(csp) ||
        /^(deny|sameorigin)$/i.test(headers['x-frame-options'] ?? ''),
    ).toBe(true);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-powered-by']).toBeUndefined();
  });
}

test('API responses do not send X-Powered-By and send nosniff', async ({ request }) => {
  const headers = (await request.get(`${web}/api/v1/health`)).headers();
  expect(headers['x-powered-by']).toBeUndefined();
  expect(headers['x-content-type-options']).toBe('nosniff');
});

test('Referrer-Policy no-referrer is sent as an HTTP header on token pages', async ({
  request,
}) => {
  for (const path of ['/reset-password?token=x', '/invite/x.y', '/verify-email?token=x']) {
    expect((await request.get(web + path)).headers()['referrer-policy']).toBe('no-referrer');
  }
});

test('Swagger UI is not published through the web origin', async ({ request }) => {
  expect((await request.get(`${web}/api/docs`)).status()).toBe(404);
  expect((await request.get(`${web}/api/docs-json`)).status()).toBe(404);
});

test.describe('clickjacking', () => {
  let server: Server;
  let attacker: string;
  test.beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(`<iframe id="victim" src="${web}/login" width="700" height="500"></iframe>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // A different origin on loopback, so Private Network Access does not hide the result.
    attacker = `http://localhost:${(server.address() as AddressInfo).port}/`;
  });
  test.afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  test('the login form cannot be rendered inside a cross-origin frame', async ({ page }) => {
    await page.goto(attacker);
    const frame = page.frameLocator('#victim');
    await page.waitForTimeout(3000);
    await expect(frame.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  });
});
