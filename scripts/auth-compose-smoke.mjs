import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const web = process.env.SMOKE_WEB_URL ?? 'http://127.0.0.1:3000';
const mailpit = process.env.SMOKE_MAILPIT_URL ?? 'http://127.0.0.1:8025';
const chrome =
  process.env.CHROME_BIN ??
  (process.platform === 'win32'
    ? join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : 'chromium');
const email = 'auth-compose-smoke@clinik.test';
const password = 'Synthetic-compose-passphrase-54';
const replacement = 'Revised-compose-passphrase-54';

function compose(...args) {
  return execFileSync(
    'docker',
    ['compose', '-p', 'clinik-smoke', '--env-file', '.env.example', ...args],
    { encoding: 'utf8' },
  ).trim();
}

function sql(statement) {
  return compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'postgres',
    '-d',
    process.env.DB_NAME ?? 'clinik_os',
    '-v',
    'ON_ERROR_STOP=1',
    '-Atc',
    statement,
  );
}

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const value = await check();
    if (value) return value;
    await delay(250);
  }
  throw new Error(message);
}

async function browserSession() {
  const profile = await mkdtemp(join(tmpdir(), 'clinik-smoke-browser-'));
  const child = spawn(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  let launchError;
  child.once('error', (error) => {
    launchError = error;
  });
  let socket;
  async function close() {
    socket?.close();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
  try {
    const port = await waitFor(async () => {
      if (launchError) throw launchError;
      return readFile(join(profile, 'DevToolsActivePort'), 'utf8')
        .then((file) => file.split(/\r?\n/, 1)[0])
        .catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
    }, 'Chromium did not start');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const target = targets.find(({ type }) => type === 'page');
    assert.ok(target, 'Chromium page target unavailable');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let requestId = 0;
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++requestId;
        const timer = setTimeout(() => {
          socket.removeEventListener('message', receive);
          reject(new Error(`Chromium did not answer ${method}`));
        }, 15_000);
        function receive(event) {
          const message = JSON.parse(event.data);
          if (message.id !== id) return;
          clearTimeout(timer);
          socket.removeEventListener('message', receive);
          if (message.error) reject(new Error(`Chromium rejected ${method}`));
          else resolve(message.result);
        }
        socket.addEventListener('message', receive);
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
    async function evaluate(fn, ...args) {
      const result = await send('Runtime.evaluate', {
        expression: `(${fn})(...${JSON.stringify(args)})`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error('Chromium could not evaluate the smoke check');
      return result.result.value;
    }
    return { send, evaluate, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function openForm(browser, url, heading) {
  await browser.send('Page.navigate', { url });
  await waitFor(
    () =>
      browser.evaluate(
        (title) =>
          document.querySelector('h1')?.textContent === title &&
          Object.keys(document.querySelector('form') ?? {}).some((key) =>
            key.startsWith('__reactProps$'),
          ),
        heading,
      ),
    `Form did not load for ${heading}`,
  );
  assert.ok(await browser.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

async function submit(browser, fields) {
  await browser.evaluate((values) => {
    const form = document.querySelector('form');
    for (const [name, value] of Object.entries(values)) form.elements.namedItem(name).value = value;
    form.requestSubmit();
  }, fields);
}

const hash = compose(
  'exec',
  '-T',
  'api',
  'node',
  '-e',
  "require('@node-rs/argon2').hash(process.argv[1], { memoryCost: 19456, timeCost: 2, parallelism: 1 }).then(console.log)",
  password,
);
assert.match(hash, /^\$argon2id\$/);
sql(`INSERT INTO users (email, full_name, password_hash, status)
  VALUES ('${email}', 'Compose Smoke Staff', '${hash}', 'active')
  ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, failed_login_count = 0, locked_until = NULL`);

const browser = await browserSession();
try {
  await browser.send('Emulation.setDeviceMetricsOverride', {
    width: 360,
    height: 800,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await browser.send('Network.enable');
  await browser.send('Network.setExtraHTTPHeaders', {
    headers: { 'X-Forwarded-For': '192.0.2.1' },
  });
  await openForm(browser, `${web}/login`, 'Sign in');
  await submit(browser, { email, password });
  await waitFor(
    () =>
      browser.evaluate(
        () =>
          location.pathname === '/app' && document.body.textContent.includes('Compose Smoke Staff'),
      ),
    'Login did not reach the authenticated account page',
  );
  const cookie = (await browser.send('Network.getCookies', { urls: [web] })).cookies.find(
    ({ name }) => name === '__Host-session',
  );
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.path === '/' && cookie.sameSite === 'Lax');
  assert.equal(cookie.domain, '127.0.0.1');
  console.log(
    'Chromium signed in through the web proxy at 360 px and used the Secure host cookie over loopback HTTP.',
  );

  await browser.send('Network.setExtraHTTPHeaders', { headers: {} });
  const statuses = await browser.evaluate(async () => {
    const attempts = [];
    for (let attempt = 2; attempt <= 21; attempt += 1) {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          'X-Forwarded-For': `192.0.2.${attempt}`,
        },
        body: JSON.stringify({ email: 'missing@clinik.test', password: 'Synthetic-smoke-attempt' }),
      });
      attempts.push({ status: res.status, retry: res.headers.get('retry-after') });
    }
    return attempts;
  });
  assert.deepEqual(
    statuses.slice(0, -1).map(({ status }) => status),
    Array(19).fill(401),
  );
  assert.equal(statuses.at(-1).status, 429);
  assert.ok(Number(statuses.at(-1).retry) > 0);
  const peer = sql(
    "SELECT count(*) || ':' || count(DISTINCT ip) || ':' || count(*) FILTER (WHERE ip <<= '192.0.2.0/24') FROM audit_logs WHERE action IN ('auth.login.success', 'auth.login.failure')",
  );
  assert.equal(peer, '20:1:0');
  console.log(
    'Forged X-Forwarded-For values reached one real-peer bucket. Attempt 21 returned 429 with Retry-After.',
  );

  await openForm(browser, `${web}/forgot-password`, 'Forgot password');
  await submit(browser, { email });
  await waitFor(
    () => browser.evaluate(() => document.body.textContent.includes('If an account matches')),
    'Forgot-password did not return confirmation',
  );
  const messageId = await waitFor(async () => {
    const res = await fetch(`${mailpit}/api/v1/messages`);
    if (!res.ok) throw new Error('Mailpit message list unavailable');
    const data = await res.json();
    return data.messages.find(({ To }) => To.some(({ Address }) => Address === email))?.ID;
  }, 'Mailpit did not receive the reset email');
  const mail = await (await fetch(`${mailpit}/api/v1/message/${messageId}`)).json();
  const match = mail.Text.match(/https?:\/\/\S+/);
  assert.ok(match, 'Reset email link missing');
  const link = new URL(match[0]);
  assert.equal(link.origin, new URL(web).origin);
  assert.equal(link.pathname, '/reset-password');
  assert.ok(link.searchParams.has('token'));
  await openForm(browser, link.href, 'Reset password');
  await submit(browser, { password: replacement });
  await waitFor(
    () => browser.evaluate(() => document.body.textContent.includes('Your password was updated')),
    'Reset email link did not complete the password reset',
  );
  const status = await browser.evaluate(async () => (await fetch('/api/v1/auth/me')).status);
  assert.equal(status, 401);
  console.log(
    'Mailpit delivered the reset email. Reset through its link succeeded and the old session returned 401.',
  );
} finally {
  await browser.close();
}
