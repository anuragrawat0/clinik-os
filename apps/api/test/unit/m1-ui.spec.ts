import {
  canonicalTimeZone,
  displayName,
  isValidTimeZone,
  normalizeTimeZone,
  timeZoneOptions,
  type RoleScope,
} from '@clinik/shared';
import { describe, expect, it } from 'vitest';
import nextConfig from '../../../web/next.config';
import {
  canEditRoles,
  canManageBranch,
  organizationNavigation,
  roleAssignmentHints,
  roleOptions,
} from '../../../web/src/features/m1/permissions';
import {
  checkResponse,
  displayError,
  problemMessage,
  sessionEndedPath,
} from '../../../web/src/lib/api-client/problems';

const manager = { role: 'branch_manager', branchId: 'A' } satisfies RoleScope;
const doctor = { role: 'doctor', branchId: 'B' } satisfies RoleScope;
const owner = { role: 'org_owner', branchId: null } satisfies RoleScope;
const admin = { role: 'org_admin', branchId: null } satisfies RoleScope;
const receptionist = { role: 'receptionist', branchId: 'A' } satisfies RoleScope;
const branches = [
  { id: 'A', status: 'active' },
  { id: 'B', status: 'active' },
  { id: 'C', status: 'inactive' },
];

describe('shared time zones', () => {
  it.each([
    ['Asia/Calcutta', 'Asia/Kolkata'],
    ['Europe/Kiev', 'Europe/Kyiv'],
    ['Asia/Saigon', 'Asia/Ho_Chi_Minh'],
    ['Asia/Katmandu', 'Asia/Kathmandu'],
    ['Asia/Rangoon', 'Asia/Yangon'],
    ['America/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
    ['Etc/UTC', 'UTC'],
    ['Etc/GMT', 'UTC'],
  ])('recognizes %s and canonicalizes it to %s', (alias, canonical) => {
    expect(isValidTimeZone(alias)).toBe(true);
    expect(isValidTimeZone(canonical)).toBe(true);
    expect(canonicalTimeZone(alias)).toBe(canonical);
    expect(canonicalTimeZone(canonical)).toBe(canonical);
  });

  it('offers sorted, unique canonical options including UTC', () => {
    const options = timeZoneOptions();
    expect(options).toEqual([...new Set(options)].sort());
    expect(options).toContain('Asia/Kolkata');
    expect(options).toContain('UTC');
    expect(options).not.toContain('Asia/Calcutta');
    expect(isValidTimeZone('Mars/Phobos')).toBe(false);
    expect(options.map(normalizeTimeZone)).toEqual(options);
  });

  it.each(['+05:30', '-03:00', 'Etc/GMT+5', 'EST', 'EST5EDT', 'GMT', 'Mars/Phobos'])(
    'rejects %s as an unsupported time zone',
    (value) => {
      expect(normalizeTimeZone(value)).toBeUndefined();
      expect(isValidTimeZone(value)).toBe(false);
      expect(timeZoneOptions()).not.toContain(value);
    },
  );

  it.each([
    ['asia/kolkata', 'Asia/Kolkata'],
    ['Etc/UTC', 'UTC'],
    ['utc', 'UTC'],
    ['America/Argentina/Buenos_Aires', 'America/Argentina/Buenos_Aires'],
  ])('normalizes %s to the supported zone %s', (input, stored) => {
    expect(normalizeTimeZone(input)).toBe(stored);
    expect(timeZoneOptions()).toContain(stored);
  });
});

describe('shared display names', () => {
  it('normalizes and trims names while preserving a joiner inside a visible name', () => {
    expect(displayName.parse(' Cafe\u0301 ')).toBe('Café');
    expect(displayName.parse('👩‍⚕️')).toBe('👩‍⚕️');
    expect(displayName.safeParse(' \u200d ').success).toBe(false);
    expect(displayName.safeParse('Clinic\n').success).toBe(false);
  });
});

describe('Next response header configuration', () => {
  it.each([
    ['/login', 'same-origin'],
    ['/app', 'same-origin'],
    ['/invite/token', 'no-referrer'],
    ['/reset-password', 'no-referrer'],
    ['/verify-email', 'no-referrer'],
  ])('sets the production headers for %s', async (path, referrer) => {
    const config = nextConfig('phase-production-build');
    const rules = (await config.headers?.()) ?? [];
    const headers = Object.fromEntries(
      rules
        .filter(
          ({ source }) =>
            source === path || (source.endsWith('/:path*') && path.startsWith(source.slice(0, -6))),
        )
        .flatMap((rule) => rule.headers.map(({ key, value }) => [key, value])),
    );
    expect(config.poweredByHeader).toBe(false);
    expect(headers).toEqual({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': referrer,
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    });
  });

  it('allows unsafe-eval only in the Next development phase', async () => {
    const development = await nextConfig('phase-development-server').headers?.();
    const production = await nextConfig('phase-production-server').headers?.();
    expect(development?.[0].headers[0].value).toContain(" 'unsafe-eval'");
    expect(production?.[0].headers[0].value).not.toContain(" 'unsafe-eval'");
  });
});

describe('M1 clinic navigation', () => {
  it.each([
    [[], ['Dashboard']],
    [[owner], ['Dashboard', 'Branches', 'Members', 'Audit log', 'Settings']],
    [[admin], ['Dashboard', 'Branches', 'Members', 'Audit log', 'Settings']],
    [
      [manager, doctor],
      ['Dashboard', 'Branches', 'Members'],
    ],
    [[doctor], ['Dashboard']],
    [[receptionist], ['Dashboard']],
  ] satisfies [RoleScope[], string[]][])('shows only the grants for %j', (roles, labels) => {
    expect(organizationNavigation(roles).map(({ label }) => label)).toEqual(labels);
  });
});

describe('clinic staff role options', () => {
  it('limits a branch manager to doctor and receptionist on branches they manage', () => {
    expect(roleOptions([manager, doctor], branches)).toEqual([
      { role: 'doctor', branchId: 'A' },
      { role: 'receptionist', branchId: 'A' },
    ]);
    expect(canManageBranch([manager, doctor], 'branch.update', 'A')).toBe(true);
    expect(canManageBranch([manager, doctor], 'branch.update', 'B')).toBe(false);
  });

  it('allows only owners to offer org admin, and never offers ownership or inactive branches', () => {
    const branchRoles = ['A', 'B'].flatMap((branchId) => [
      { role: 'branch_manager', branchId },
      { role: 'doctor', branchId },
      { role: 'receptionist', branchId },
    ]);
    expect(roleOptions([admin], branches)).toHaveLength(branchRoles.length);
    expect(roleOptions([admin], branches)).toEqual(expect.arrayContaining(branchRoles));
    const options = roleOptions([owner], branches);
    expect(options).toHaveLength(branchRoles.length + 1);
    expect(options).toEqual(
      expect.arrayContaining([{ role: 'org_admin', branchId: null }, ...branchRoles]),
    );
    expect(roleOptions([doctor], branches)).toEqual([]);
  });
});

describe('role editor availability', () => {
  const doctorA = { ...doctor, branchId: 'A' };
  it.each([
    ['admin to owner', [admin], [owner], false, false],
    ['admin to admin', [admin], [doctorA, admin], false, false],
    ['owner to admin', [doctor, owner], [admin], false, true],
    ['manager to doctor in scope', [manager], [doctorA], false, true],
    ['manager to doctor outside scope', [manager], [doctor], false, false],
    ['manager to doctor in and outside scope', [manager], [doctorA, doctor], false, false],
    ['manager to peer', [manager], [manager, doctorA], false, false],
    ['doctor to doctor', [doctorA], [doctor], false, false],
    ['doctor to self with two roles', [doctorA, doctor], [doctorA, doctor], true, false],
    ['owner to self with branch role', [owner, manager], [owner, manager], true, true],
    ['owner to self with only ownership', [owner], [owner], true, false],
    ['admin to self with one role', [admin], [admin], true, false],
    ['manager to self with two roles', [manager, doctor], [manager, doctor], true, true],
  ] as const)('%s', (_name, actorRoles, targetRoles, isSelf, allowed) => {
    expect(canEditRoles(actorRoles, targetRoles, isSelf)).toBe(allowed);
  });
});

describe('role editor hints', () => {
  const adminHint = "Organization admin already covers most of this branch role's tasks.";
  const verificationHint = 'This person can verify patient identity through the receptionist role.';
  const doctorAtReception: RoleScope = { ...doctor, branchId: receptionist.branchId };

  it.each([manager, doctor, receptionist])('shows the admin hint with $role', (branchRole) => {
    expect(roleAssignmentHints([admin, branchRole])).toEqual([adminHint]);
  });

  it('shows the verification hint for the same branch and different branches', () => {
    expect(roleAssignmentHints([doctorAtReception, receptionist])).toEqual([verificationHint]);
    expect(roleAssignmentHints([doctor, receptionist])).toEqual([verificationHint]);
  });

  it('shows both hints once when several branch assignments overlap', () => {
    expect(roleAssignmentHints([manager, receptionist, admin, doctor, doctorAtReception])).toEqual([
      adminHint,
      verificationHint,
    ]);
  });

  it.each([[[]], [[admin]], [[doctor]], [[receptionist]], [[owner, manager]], [[manager, doctor]]])(
    'leaves unrelated combinations without hints (%j)',
    (roles) => {
      expect(roleAssignmentHints(roles)).toEqual([]);
    },
  );
});

describe('problem details display', () => {
  it.each([
    ['FORBIDDEN', 'permission'],
    ['NOT_FOUND', 'could not be found'],
    ['BRANCH_INACTIVE', 'Reactivate'],
    ['INVITATION_PENDING', 'already pending'],
    ['ALREADY_HAS_ROLE', 'already has'],
    ['OWNER_EXISTS', 'already has an owner'],
    ['ORG_SLUG_TAKEN', 'clinic URL'],
    ['BRANCH_CODE_TAKEN', 'branch code'],
    ['INVALID_TIMEZONE', 'time zone'],
    ['INVALID_PASSWORD', 'password is incorrect'],
    ['INVALID_TOKEN', 'This link has expired or was already used. Request a new one.'],
    ['SELF_GRANT_FORBIDDEN', 'your own roles'],
    ['EMPTY_ROLES', 'Keep at least one role'],
    ['RATE_LIMITED', 'Too many attempts'],
    ['UNAUTHENTICATED', 'Your session ended'],
  ])('maps %s to a safe message', (code, copy) => {
    expect(problemMessage({ code, detail: 'do not display this' })).toContain(copy);
    expect(problemMessage({ code, detail: 'do not display this' })).not.toContain(
      'do not display this',
    );
  });

  it('uses a fixed session-ended path and safe fallbacks', () => {
    expect(sessionEndedPath).toBe('/login?reason=session-ended');
    expect(() => checkResponse(new Response(null, { status: 401 }), undefined)).toThrow(
      'Your session ended',
    );
    expect(problemMessage({ code: 'constructor' })).toBe(problemMessage(undefined));
    expect(displayError(new Error('private data'))).toBe(problemMessage(undefined));
  });
});
