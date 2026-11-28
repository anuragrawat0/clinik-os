import { describe, expect, it } from 'vitest';
import { acceptInvitationInput } from '../../src/modules/tenancy/invitation.dto';
import { createBranchInput, createOrganizationInput } from '../../src/modules/tenancy/tenancy.dto';

/**
 * Audit 2026-11-28 (B4). Display names are rendered to other users (members list, audit actor names,
 * invitation preview, email display name). Invisible and control characters should be rejected.
 */
const hostile = [
  ['CR/LF', 'Bob\r\nBcc: evil@example.test'],
  ['zero-width only', '​'],
  ['bidi override', '‮gnp.exe'],
  ['C0 control', 'Clinic\u0007'],
] as const;

describe('AUDIT B4: names reject invisible and control characters', () => {
  for (const [label, value] of hostile) {
    it(`organization name: ${label}`, () => {
      expect(
        createOrganizationInput.safeParse({ name: value, slug: 'audit-x', defaultTimezone: 'UTC' })
          .success,
      ).toBe(false);
    });
    it(`branch name: ${label}`, () => {
      expect(
        createBranchInput.safeParse({ name: value, code: 'AU', timezone: 'UTC' }).success,
      ).toBe(false);
    });
    it(`invitee full name: ${label}`, () => {
      expect(
        acceptInvitationInput.safeParse({ fullName: value, password: 'x'.repeat(16) }).success,
      ).toBe(false);
    });
  }
});
