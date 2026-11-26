import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const projectName = process.env.COMPOSE_PROJECT_NAME?.trim() ?? '';
if (!/^[a-z0-9][a-z0-9_-]*$/.test(projectName) || projectName === 'clinik-os') {
  console.error('WF-1 requires a valid COMPOSE_PROJECT_NAME other than clinik-os.');
  process.exit(1);
}

const web = new URL(process.env.SMOKE_WEB_URL ?? 'http://127.0.0.1:3000').origin;
const mailpit = new URL(process.env.SMOKE_MAILPIT_URL ?? 'http://127.0.0.1:8025').origin;
const artifacts = resolve(process.env.SMOKE_ARTIFACT_DIR ?? 'wf1-artifacts');
const slug = 'wf1-clinic';
const otherSlug = 'wf1-other-clinic';
const runId = randomBytes(6).toString('hex');
const password = randomBytes(24).toString('base64url');
const secretValues = new Set([password]);
const actors = [];
const people = Object.fromEntries(
  ['admin', 'owner', 'manager', 'doctor', 'receptionist'].map((role) => [
    role,
    { name: `WF1 ${role}`, email: `wf1-${role}-${runId}@clinik.test` },
  ]),
);
const writeHeaders = { 'X-Requested-With': 'XMLHttpRequest' };
const check = expect.configure({ timeout: 12_000 });
let step = 'bootstrap platform administrator';
let browser;

function compose(args, options = {}) {
  const result = spawnSync(
    'docker',
    ['compose', '-p', projectName, '--env-file', '.env.example', ...args],
    {
      encoding: 'utf8',
      timeout: 60_000,
      ...options,
    },
  );
  if (result.error || result.status !== 0) throw new Error('Compose command failed');
  return result.stdout.trim();
}

function bootstrap() {
  const databaseUrl = compose(['exec', '-T', 'api', 'printenv', 'DATABASE_URL']);
  assert.equal(new URL(databaseUrl).username, 'clinic_app');
  const id = compose(
    [
      'run',
      '--rm',
      '-T',
      '-e',
      'DATABASE_URL',
      'migrate',
      'node',
      'dist/cli/create-admin.js',
      '--email',
      people.admin.email,
      '--name',
      people.admin.name,
    ],
    { env: { ...process.env, DATABASE_URL: databaseUrl }, input: `${password}\n` },
  );
  assert.match(id, /^[a-f0-9-]{36}$/i);
}

async function newPage(role) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
  const page = await context.newPage();
  actors.push({ context, page, role });
  return page;
}

async function signOut(page, person) {
  for (const { name, value } of await page.context().cookies(web)) {
    if (name === '__Host-session') secretValues.add(value);
  }
  await page.locator('summary').filter({ hasText: person.name }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await check(page).toHaveURL(`${web}/login`);
}

async function createClinic(page, { name, clinicSlug, owner }) {
  await page.getByRole('button', { name: 'Create organization', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create organization' });
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Slug', { exact: true }).fill(clinicSlug);
  if (owner) {
    await dialog.getByLabel('Owner email (optional)', { exact: true }).fill(owner.email);
    await dialog.getByLabel('Owner full name (optional)', { exact: true }).fill(owner.name);
  }
  await dialog.getByRole('button', { name: 'Create organization', exact: true }).click();
  await check(dialog).toBeHidden();
  const row = page
    .getByRole('table', { name: 'Organizations' })
    .getByRole('link', { name, exact: true });
  await check(row).toBeVisible();
  return (await row.getAttribute('href'))?.split('/').at(-1);
}

async function mailLink(person, subject, linkPattern) {
  let link;
  await check
    .poll(
      async () => {
        const list = await fetch(`${mailpit}/api/v1/messages`);
        if (!list.ok) return false;
        const { messages } = await list.json();
        const message = messages.find(
          ({ To, Subject }) =>
            Subject === subject && To.some(({ Address }) => Address === person.email),
        );
        if (!message) return false;
        const response = await fetch(`${mailpit}/api/v1/message/${encodeURIComponent(message.ID)}`);
        if (!response.ok) return false;
        const mail = await response.json();
        link = mail.Text.match(linkPattern)?.[0];
        return Boolean(link);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  return link;
}

async function acceptInvitation(role) {
  const person = people[role];
  const page = await newPage(role);
  const path = await mailLink(
    person,
    'Your Clinik OS invitation',
    /\/invite\/[a-f0-9-]{36}\.[a-z0-9_-]{43}/i,
  );
  secretValues.add(path.split('.').at(-1));
  await page.goto(web + path);
  await page.getByLabel('Full name', { exact: true }).fill(person.name);
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account and accept' }).click();
  await check(page).toHaveURL(`${web}/o/${slug}`);
  await check(page.getByRole('heading', { name: 'WF1 Clinic' })).toBeVisible();
  return page;
}

async function addBranch(page, letter) {
  await page.getByRole('button', { name: 'Create branch', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create branch' });
  await dialog.getByLabel('Code', { exact: true }).fill(letter.repeat(2));
  await dialog.getByLabel('Name', { exact: true }).fill(`Branch ${letter}`);
  await dialog.getByRole('button', { name: 'Create branch', exact: true }).click();
  await check(dialog).toBeHidden();
  await check(page.getByRole('cell', { name: `Branch ${letter}`, exact: true })).toBeVisible();
}

async function invite(page, person, role, branch) {
  await page.getByRole('button', { name: 'Invite staff' }).click();
  const dialog = page.getByRole('dialog', { name: 'Invite staff' });
  await dialog.getByLabel('Email', { exact: true }).fill(person.email);
  await dialog.getByLabel('Role', { exact: true }).selectOption(role);
  await dialog.getByLabel('Branch', { exact: true }).selectOption({ label: `Branch ${branch}` });
  await dialog.getByRole('button', { name: 'Send invitation' }).click();
  await check(dialog).toBeHidden();
  await check(page.getByRole('status').filter({ hasText: 'Invitation sent.' })).toBeVisible();
}

async function workflow() {
  bootstrap();
  step = 'launch Chromium';
  browser = await chromium.launch(
    process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {},
  );
  const admin = await newPage('admin');

  step = 'sign in and create clinics through the admin UI';
  await admin.goto(`${web}/login`);
  await admin.getByLabel('Email', { exact: true }).fill(people.admin.email);
  await admin.getByLabel('Password', { exact: true }).fill(password);
  await admin.getByRole('button', { name: 'Sign in', exact: true }).click();
  await check(admin).toHaveURL(`${web}/admin/organizations`);
  const orgId = await createClinic(admin, {
    name: 'WF1 Clinic',
    clinicSlug: slug,
    owner: people.owner,
  });
  assert.match(orgId ?? '', /^[a-f0-9-]{36}$/i);
  await createClinic(admin, { name: 'WF1 Other Clinic', clinicSlug: otherSlug });
  await signOut(admin, people.admin);

  step = 'accept the owner invitation through Mailpit';
  const owner = await acceptInvitation('owner');
  const ownerNav = owner.getByRole('navigation', { name: 'Clinic navigation' });
  step = 'create branches and invite staff through the UI';
  await ownerNav.getByRole('link', { name: 'Branches' }).click();
  await addBranch(owner, 'A');
  await addBranch(owner, 'B');
  await ownerNav.getByRole('link', { name: 'Members' }).click();
  await invite(owner, people.manager, 'branch_manager', 'A');
  await invite(owner, people.doctor, 'doctor', 'A');
  await invite(owner, people.receptionist, 'receptionist', 'B');

  step = 'accept staff invitations through Mailpit';
  const manager = await acceptInvitation('manager');
  const doctor = await acceptInvitation('doctor');
  const receptionist = await acceptInvitation('receptionist');

  step = 'check the manager’s branch scope and grant restrictions';
  await manager
    .getByRole('navigation', { name: 'Clinic navigation' })
    .getByRole('link', { name: 'Members' })
    .click();
  const staff = manager.getByRole('table', { name: 'Staff members' });
  const managerDoctorRow = staff.getByRole('row').filter({ hasText: people.doctor.email });
  const removeDoctor = managerDoctorRow.getByRole('button', { name: 'Remove', exact: true });
  await check(removeDoctor).toBeVisible();

  await owner.reload();
  const ownerDoctorRow = owner.getByRole('row').filter({ hasText: people.doctor.email });
  await ownerDoctorRow.getByRole('button', { name: 'Edit roles' }).click();
  const editor = owner.getByRole('dialog', { name: `Edit roles for ${people.doctor.name}` });
  await editor.getByLabel('Doctor · Branch B', { exact: true }).check();
  await editor.getByRole('button', { name: 'Save roles' }).click();
  await check(editor).toBeHidden();
  await check(ownerDoctorRow.getByText('Doctor · Branch B', { exact: true })).toBeVisible();

  await manager.reload();
  await check(staff.getByRole('row')).toHaveCount(4);
  const managerOwnerRow = staff.getByRole('row').filter({ hasText: people.owner.email });
  await check(managerOwnerRow.getByRole('listitem')).toHaveText([
    'Organization owner · All branches',
  ]);
  await check(managerOwnerRow.getByRole('button', { name: 'Edit roles' })).toHaveCount(0);
  await check(staff.getByRole('row').filter({ hasText: people.manager.email })).toContainText(
    'Branch manager · Branch A',
  );
  await check(managerDoctorRow).toContainText('Doctor · Branch A');
  await check(removeDoctor).toHaveCount(0);
  await check(staff.getByText('Doctor · Branch B', { exact: true })).toHaveCount(0);
  await check(staff.getByText(people.receptionist.email, { exact: true })).toHaveCount(0);

  await manager.getByRole('button', { name: 'Invite staff' }).click();
  const restricted = manager.getByRole('dialog', { name: 'Invite staff' });
  await check(restricted.getByRole('option', { name: 'Branch manager', exact: true })).toHaveCount(
    0,
  );
  await restricted.getByLabel('Role', { exact: true }).selectOption('doctor');
  const branchA = await restricted
    .getByRole('option', { name: 'Branch A', exact: true })
    .getAttribute('value');
  assert.ok(branchA);
  await check(restricted.getByRole('option', { name: 'Branch B', exact: true })).toHaveCount(0);
  await manager.keyboard.press('Escape');
  await check(restricted).toBeHidden();
  const blocked = await manager.request.post(`${web}/api/v1/orgs/${orgId}/invitations`, {
    headers: writeHeaders,
    data: { role: 'branch_manager', branchId: branchA, email: `wf1-denied-${runId}@clinik.test` },
  });
  assert.equal(blocked.status(), 403);

  step = 'check navigation, tenant isolation, and immediate logout';
  const doctorNav = doctor.getByRole('navigation', { name: 'Clinic navigation' });
  await check(doctorNav.getByRole('link', { name: 'Dashboard', exact: true })).toBeVisible();
  for (const name of ['Members', 'Branches', 'Audit log']) {
    await check(doctorNav.getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  const switcher = receptionist.getByLabel('Switch clinic', { exact: true });
  await check(switcher.getByRole('option')).toHaveText(['WF1 Clinic']);
  await receptionist.goto(`${web}/o/${otherSlug}`);
  await check(receptionist.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  const oldSession = (await receptionist.context().cookies(web)).find(
    ({ name }) => name === '__Host-session',
  );
  assert.ok(oldSession);
  secretValues.add(oldSession.value);
  await signOut(receptionist, people.receptionist);
  const revoked = await fetch(`${web}/api/v1/auth/me`, {
    headers: { Cookie: `${oldSession.name}=${oldSession.value}` },
  });
  assert.equal(revoked.status, 401);

  step = 'check the owner audit log';
  await ownerNav.getByRole('link', { name: 'Audit log' }).click();
  const audit = owner.getByRole('table', { name: 'Audit events' });
  const creation = audit.getByRole('row').filter({
    has: owner.getByRole('cell', { name: 'organization.created', exact: true }),
  });
  await check(
    creation.getByRole('cell', { name: 'Platform administrator', exact: true }),
  ).toHaveCount(1);
  for (const [action, count] of [
    ['organization.created', 1],
    ['invitation.created', 4],
    ['invitation.accepted', 4],
    ['branch.created', 2],
  ]) {
    await check(audit.getByRole('cell', { name: action, exact: true })).toHaveCount(count);
  }

  step = 'reset a staff password from Mailpit with Enter and sign in with the replacement';
  const replacement = randomBytes(24).toString('base64url');
  secretValues.add(replacement);
  await receptionist.goto(`${web}/forgot-password`);
  const resetEmail = receptionist.getByLabel('Email', { exact: true });
  await resetEmail.fill(people.receptionist.email);
  await check(receptionist.getByRole('button', { name: 'Send reset link' })).toBeEnabled();
  await resetEmail.press('Enter');
  await check(receptionist.getByRole('status')).toContainText('If an account matches');
  const resetLink = await mailLink(
    people.receptionist,
    'Reset your Clinik OS password',
    /\/reset-password\?token=[a-z0-9_-]{43}/i,
  );
  secretValues.add(resetLink.split('=').at(-1));
  await receptionist.goto(web + resetLink);
  await check(receptionist).toHaveURL(`${web}/reset-password`);
  const newPassword = receptionist.getByLabel('New password', { exact: true });
  await newPassword.fill(replacement);
  await check(receptionist.getByRole('button', { name: 'Save new password' })).toBeEnabled();
  await newPassword.press('Enter');
  await check(receptionist.getByRole('status')).toContainText('Your password was updated');
  await check(receptionist).toHaveURL(`${web}/reset-password`);
  await receptionist.getByRole('link', { name: 'Back to sign in' }).click();
  await receptionist.getByLabel('Email', { exact: true }).fill(people.receptionist.email);
  const loginPassword = receptionist.getByLabel('Password', { exact: true });
  await loginPassword.fill(replacement);
  await check(receptionist.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await loginPassword.press('Enter');
  await check(receptionist).toHaveURL(`${web}/o/${slug}`);
}

async function saveFailureArtifacts() {
  await mkdir(artifacts, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'clinik-wf1-trace-'));
  try {
    for (const { context, page, role } of actors) {
      for (const cookie of await context.cookies().catch(() => [])) {
        if (cookie.value) secretValues.add(cookie.value);
      }
      await page
        .screenshot({
          path: join(artifacts, `${role}.png`),
          mask: [page.locator('input[type="password"]')],
          timeout: 5_000,
        })
        .catch(() => undefined);
    }
    for (const { context, role } of actors) {
      try {
        const raw = join(scratch, `${role}-raw.zip`);
        await context.tracing.stop({ path: raw });
        const names = execFileSync('unzip', ['-Z1', raw], { encoding: 'utf8' })
          .split(/\r?\n/)
          .filter((name) => /^[\w-]+\.trace$/.test(name));
        const archive = [];
        for (const name of names) {
          let content = execFileSync('unzip', ['-p', raw, name], {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
          });
          for (const secret of secretValues) content = content.replaceAll(secret, '[redacted]');
          content = content.replace(/\b[A-Za-z0-9_-]{43}\b/g, '[redacted]');
          const file = join(scratch, name);
          await writeFile(file, content, 'utf8');
          archive.push(file);
        }
        // Network events and resources can contain authentication data. Publish action traces only.
        if (archive.length)
          execFileSync('zip', ['-j', '-q', join(artifacts, `${role}-trace.zip`), ...archive], {
            stdio: 'ignore',
          });
      } catch {
        console.error(`Could not save the sanitized ${role} trace.`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

try {
  await workflow();
  console.log('WF-1 passed.');
} catch {
  console.error(`WF-1 failed during: ${step}.`);
  await saveFailureArtifacts().catch(() => console.error('Could not save WF-1 failure artifacts.'));
  process.exitCode = 1;
} finally {
  await browser?.close();
}
