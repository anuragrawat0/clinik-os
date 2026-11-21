import { describe, expect, it, vi } from 'vitest';
import { PasswordService } from '../../src/modules/identity/core/password.service';

const context = { email: 'maria.gomez@clinic.test', fullName: 'Maria Gomez' };

describe('PasswordService', () => {
  const service = new PasswordService();

  it('hashes with argon2id at m>=19456 KiB, t=2, p=1 (read back from the PHC string)', async () => {
    const hash = await service.hash('correct horse battery staple');
    const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(19_456);
    expect(Number(match?.[2])).toBe(2);
    expect(Number(match?.[3])).toBe(1);
  });

  it('verifies the right password, rejects a wrong one and never throws on garbage hashes', async () => {
    const hash = await service.hash('correct horse battery staple');
    await expect(service.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(service.verify(hash, 'correct horse battery stapl3')).resolves.toBe(false);
    await expect(service.verify('not-a-hash', 'x')).resolves.toBe(false);
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([
      service.hash('same-password-123'),
      service.hash('same-password-123'),
    ]);
    expect(a).not.toBe(b);
  });

  it('dummyVerify performs a real argon2 verification of the same cost and resolves', async () => {
    const verify = vi.spyOn(service, 'verify');
    await expect(service.dummyVerify()).resolves.toBeUndefined();
    expect(verify).toHaveBeenCalledTimes(1);
    const dummyHash = verify.mock.calls[0]?.[0] ?? '';
    expect(dummyHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  describe('checkPolicy', () => {
    it('accepts a 12+ character password without composition rules', () => {
      expect(service.checkPolicy('maple-river-orbit', context)).toBe('ok');
      expect(service.checkPolicy('correct horse battery staple', context)).toBe('ok');
    });

    it('rejects too short (11 chars) and accepts exactly 12', () => {
      expect(service.checkPolicy('a'.repeat(11), context)).toBe('PASSWORD_TOO_SHORT');
      expect(service.checkPolicy('xqzjvkwpmrtn', context)).toBe('ok');
    });

    it('rejects absurdly long input to bound hashing cost', () => {
      expect(service.checkPolicy('a1b2'.repeat(40), context)).toBe('PASSWORD_TOO_LONG');
    });

    it('rejects common passwords case-insensitively', () => {
      expect(service.checkPolicy('password1234', context)).toBe('PASSWORD_TOO_COMMON');
      expect(service.checkPolicy('PassWord1234', context)).toBe('PASSWORD_TOO_COMMON');
      expect(service.checkPolicy('qwertyuiop123', context)).toBe('PASSWORD_TOO_COMMON');
    });

    it('rejects passwords containing the email or its local part', () => {
      expect(service.checkPolicy('xx-maria.gomez@clinic.test-xx', context)).toBe(
        'PASSWORD_CONTAINS_EMAIL',
      );
      expect(service.checkPolicy('Maria.Gomez-2026-ok', context)).toBe('PASSWORD_CONTAINS_EMAIL');
    });

    it('does not apply the local-part rule to very short local parts', () => {
      expect(
        service.checkPolicy('a-long-unrelated-phrase', { email: 'ab@clinic.test', fullName: 'x' }),
      ).toBe('ok');
    });
  });
});
