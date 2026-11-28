import { expect, test, type Locator, type Page, type Request } from '@playwright/test';

const web = new URL(process.env.SMOKE_WEB_URL ?? 'http://127.0.0.1:3000').origin;
const email = 'form-security@clinik.test';
const password = 'Synthetic-form-security-password';
const resetToken = 'synthetic-reset-token';
const inviteToken = 'synthetic-invitation-token';
const clinicId = '10000000-0000-0000-0000-000000000001';
const candidateId = '10000000-0000-0000-0000-000000000002';
const clinicApi = `/api/v1/orgs/${clinicId}`;
const settingsPath = '/o/form-safety/settings';
const invitePath = `/invite/${inviteToken}`;
const inviteApi = `/api/v1/auth/invitations/${inviteToken}`;

function hasCredentials(url: URL) {
  return [...url.searchParams.keys()].some((name) =>
    /^(password|email|token|access_token|code)$/i.test(name),
  );
}

async function checkPostForm(button: Locator) {
  const form = button.locator('xpath=ancestor::form');
  await expect(form).toHaveAttribute('method', 'post');
  expect(await form.getAttribute('action')).toBeNull();
}

for (const { path, submit, field, emailField, tokenInLink } of [
  { path: '/login', submit: 'Sign in', field: 'Password', emailField: true },
  { path: '/forgot-password', submit: 'Send reset link', field: 'Email' },
  {
    path: `/reset-password?token=${resetToken}`,
    submit: 'Save new password',
    field: 'New password',
    tokenInLink: true,
  },
]) {
  test(`${submit} blocks native submission before hydration`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      const submissions: Request[] = [];
      await page.goto(web + path);
      page.on('request', (request) => {
        if (request.isNavigationRequest()) submissions.push(request);
      });
      const button = page.getByRole('button', { name: submit, exact: true });
      await checkPostForm(button);
      await expect(button).toBeDisabled();
      if (emailField) await page.getByLabel('Email', { exact: true }).fill(email);
      const input = page.getByLabel(field, { exact: true });
      await input.fill(field === 'Email' ? email : password);
      const position = await button.boundingBox();
      if (!position) throw new Error('Expected a visible submit button');
      await page.mouse.click(position.x + position.width / 2, position.y + position.height / 2);
      await input.press('Enter');
      expect(submissions).toHaveLength(0);
      const url = new URL(page.url());
      if (tokenInLink) {
        expect(url.searchParams.get('token')).toBe(resetToken);
        url.searchParams.delete('token');
      }
      expect(hasCredentials(url)).toBe(false);
    } finally {
      await context.close();
    }
  });
}

for (const [name, path] of [
  ['Invitation acceptance', invitePath],
  ['Ownership transfer', settingsPath],
]) {
  test(`${name} has no password form before hydration`, async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto(web + path);
      await expect(page.locator('input[type="password"]')).toHaveCount(0);
      await page.keyboard.press('Enter');
      expect(hasCredentials(new URL(page.url()))).toBe(false);
    } finally {
      await context.close();
    }
  });
}

async function expectCleanUrl(page: Page, path: string) {
  await expect(page).toHaveURL((url) => url.pathname === path && !hasCredentials(url));
}

test('unexpected credential parameters vanish without appearing on the page', async ({ page }) => {
  await page.goto(
    `${web}/login?password=${password}&email=${email}&token=unused&reason=session-ended`,
  );
  await expectCleanUrl(page, '/login');
  expect(new URL(page.url()).searchParams.get('reason')).toBe('session-ended');
  for (const value of [password, email, 'unused']) {
    expect(await page.locator('body').innerText()).not.toContain(value);
  }
});

for (const [path, cleanPath] of [
  ['/login', '/login'],
  ['/reset-password', '/reset-password'],
  ['/verify-email', '/verify-email'],
  ['/forgot-password', '/forgot-password'],
  ['/invite', '/invite'],
  [invitePath, '/invite'],
]) {
  test(`auth query allowlist strips every unexpected parameter on ${path}`, async ({ page }) => {
    await page.route(`**${inviteApi}`, (route) => route.fulfill({ status: 404 }));
    await page.goto(
      `${web}${path}?access_token=synthetic&code=synthetic&extra=yes&token=synthetic`,
    );
    await expect(page).toHaveURL(`${web}${cleanPath}`);
  });
}

test('login retains only a valid reason and same-origin next path', async ({ page }) => {
  await page.goto(
    `${web}/login?reason=session-ended&next=%2Fapp&access_token=synthetic&code=synthetic`,
  );
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/login' &&
      url.searchParams.size === 2 &&
      url.searchParams.get('reason') === 'session-ended' &&
      url.searchParams.get('next') === '/app',
  );
  for (const next of [
    'https://example.test/app',
    '//example.test/app',
    '/\\example.test/app',
    '/app?code=synthetic',
  ]) {
    await page.goto(`${web}/login?next=${encodeURIComponent(next)}&reason=anything-else`);
    await expect(page).toHaveURL(`${web}/login`);
  }
  await page.goto(`${web}/login?next=%2Fapp&next=%2Fother`);
  await expect(page).toHaveURL(`${web}/login`);
});

async function submitByEnter({
  page,
  field,
  button,
  endpoint,
  body,
}: {
  page: Page;
  field: Locator;
  button: Locator;
  endpoint: string;
  body: Record<string, string>;
}) {
  await checkPostForm(button);
  await expect(button).toBeEnabled();
  const request = page.waitForRequest(
    (candidate) => new URL(candidate.url()).pathname === endpoint,
  );
  await field.press('Enter');
  const submission = await request;
  expect(submission.method()).toBe('POST');
  expect(submission.headers()['x-requested-with']).toBe('XMLHttpRequest');
  expect(hasCredentials(new URL(submission.url()))).toBe(false);
  expect(submission.postDataJSON()).toEqual(body);
  expect(hasCredentials(new URL(page.url()))).toBe(false);
}

test('reset by Enter sends the captured link token and shows completion', async ({ page }) => {
  const endpoint = '/api/v1/auth/password/reset';
  await page.route(`**${endpoint}`, (route) => route.fulfill({ status: 204 }));
  const document = await page.goto(`${web}/reset-password?token=${resetToken}&email=${email}`);
  expect(document?.headers()['referrer-policy']).toBe('no-referrer');
  await expectCleanUrl(page, '/reset-password');
  const input = page.getByLabel('New password', { exact: true });
  await input.fill(password);
  await submitByEnter({
    page,
    field: input,
    button: page.getByRole('button', { name: 'Save new password' }),
    endpoint,
    body: { token: resetToken, password },
  });
  await expect(page.getByRole('status')).toHaveText(
    'Your password was updated. You can now sign in.',
  );
  await expectCleanUrl(page, '/reset-password');
});

test('login by Enter submits credentials only in the POST body', async ({ page }) => {
  const endpoint = '/api/v1/auth/login';
  await page.route(`**${endpoint}`, (route) =>
    route.fulfill({ status: 401, json: { code: 'INVALID_PASSWORD' } }),
  );
  await page.goto(`${web}/login`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  const input = page.getByLabel('Password', { exact: true });
  await input.fill(password);
  await submitByEnter({
    page,
    field: input,
    button: page.getByRole('button', { name: 'Sign in', exact: true }),
    endpoint,
    body: { email, password },
  });
});

test('forgot password by Enter submits the email only in the POST body', async ({ page }) => {
  const endpoint = '/api/v1/auth/password/forgot';
  await page.route(`**${endpoint}`, (route) =>
    route.fulfill({ status: 202, json: { accepted: true } }),
  );
  await page.goto(`${web}/forgot-password`);
  const input = page.getByLabel('Email', { exact: true });
  await input.fill(email);
  await submitByEnter({
    page,
    field: input,
    button: page.getByRole('button', { name: 'Send reset link' }),
    endpoint,
    body: { email },
  });
  await expect(page.getByRole('status')).toContainText('If an account matches');
});

for (const existing of [false, true]) {
  test(`invitation by Enter keeps the token for an ${existing ? 'existing' : 'unregistered'} account`, async ({
    page,
  }) => {
    await page.route(`**${inviteApi}`, (route) =>
      route.fulfill({
        json: { organizationName: 'Synthetic Clinic', role: 'doctor', branchName: 'Main', email },
      }),
    );
    const endpoint = `${inviteApi}/accept`;
    await page.route(`**${endpoint}`, (route) => route.fulfill({ status: 204 }));
    await page.route('**/api/v1/auth/me', (route) => route.fulfill({ status: 401 }));
    const document = await page.goto(
      `${web}${invitePath}?password=${password}&email=unexpected@clinik.test&token=unexpected`,
    );
    expect(document?.headers()['referrer-policy']).toBe('no-referrer');
    await expectCleanUrl(page, '/invite');
    if (existing) {
      await page.route('**/api/v1/auth/login', (route) => {
        expect(route.request().method()).toBe('POST');
        expect(hasCredentials(new URL(route.request().url()))).toBe(false);
        expect(route.request().postDataJSON()).toEqual({ email, password });
        return route.fulfill({ status: 204 });
      });
      await page.getByRole('button', { name: 'I already have an account' }).click();
      await expect(page.getByLabel('Email', { exact: true })).toHaveValue(email);
    } else {
      await page.getByLabel('Full name', { exact: true }).fill('Synthetic Invitee');
    }
    const input = page.getByLabel(existing ? 'Password' : 'New password', { exact: true });
    await input.fill(password);
    await submitByEnter({
      page,
      field: input,
      button: page.getByRole('button', {
        name: existing ? 'Sign in and accept' : 'Create account and accept',
      }),
      endpoint,
      body: existing ? {} : { fullName: 'Synthetic Invitee', password },
    });
  });
}

async function mockOwnerSettings(page: Page) {
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 'synthetic-owner', fullName: 'Synthetic Owner', email, isPlatformAdmin: false },
        memberships: [
          {
            organizationId: clinicId,
            organizationSlug: 'form-safety',
            organizationName: 'Synthetic Clinic',
            roles: [{ role: 'org_owner', branchId: null }],
          },
        ],
        patientProfiles: [],
      },
    }),
  );
  await page.route(`**${clinicApi}`, (route) =>
    route.fulfill({ json: { name: 'Synthetic Clinic', defaultTimezone: 'UTC' } }),
  );
  await page.route(`**${clinicApi}/members`, (route) =>
    route.fulfill({
      json: [{ userId: candidateId, fullName: 'New Owner', email: 'new-owner@clinik.test' }],
    }),
  );
}

test('ownership transfer by Enter submits the current password only in the POST body', async ({
  page,
}) => {
  await mockOwnerSettings(page);
  const endpoint = `${clinicApi}/ownership-transfer`;
  await page.route(`**${endpoint}`, (route) => route.fulfill({ status: 204 }));
  await page.goto(`${web}${settingsPath}?email=${email}&password=${password}`);
  await expectCleanUrl(page, settingsPath);
  await page.getByRole('button', { name: 'Transfer ownership' }).click();
  await page.getByLabel('New owner').selectOption(candidateId);
  const input = page.getByLabel('Current password', { exact: true });
  await input.fill(password);
  await submitByEnter({
    page,
    field: input,
    button: page.getByRole('button', { name: 'Confirm transfer' }),
    endpoint,
    body: { newOwnerUserId: candidateId, currentPassword: password },
  });
  await expect(page.getByRole('status')).toHaveText('Ownership transferred.');
});

test('double-clicking Confirm transfer sends exactly one ownership transfer request', async ({
  page,
}) => {
  await mockOwnerSettings(page);
  const endpoint = `${clinicApi}/ownership-transfer`;
  let requests = 0;
  let release!: () => void;
  const heldResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**${endpoint}`, async (route) => {
    requests++;
    await heldResponse;
    await route.fulfill({ status: 204 });
  });
  await page.goto(web + settingsPath);
  await page.getByRole('button', { name: 'Transfer ownership' }).click();
  await page.getByLabel('New owner').selectOption(candidateId);
  await page.getByLabel('Current password', { exact: true }).fill(password);
  try {
    await page.getByRole('button', { name: 'Confirm transfer' }).dblclick();
    await expect.poll(() => requests).toBe(1);
  } finally {
    release();
  }
  await expect(page.getByRole('status')).toHaveText('Ownership transferred.');
  expect(requests).toBe(1);
});
