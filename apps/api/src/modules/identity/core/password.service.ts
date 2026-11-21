import { Injectable } from '@nestjs/common';
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARGON2_MEMORY_COST_KIB,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './identity.constants';
import type { PasswordPolicyResult } from './types';

const MIN_EMAIL_LOCAL_PART_LENGTH = 4;

function loadCommonPasswords(): ReadonlySet<string> {
  const text = readFileSync(join(__dirname, 'common-passwords.txt'), 'utf8');
  return new Set(
    text
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
}

@Injectable()
export class PasswordService {
  private readonly common = loadCommonPasswords();
  private dummyHash: Promise<string> | undefined;

  /** argon2id (the library default algorithm) with the approved parameters. */
  hash(plain: string): Promise<string> {
    return argon2Hash(plain, {
      memoryCost: ARGON2_MEMORY_COST_KIB,
      timeCost: ARGON2_TIME_COST,
      parallelism: ARGON2_PARALLELISM,
    });
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2Verify(hash, plain);
    } catch {
      return false;
    }
  }

  /** Burns the same argon2 cost as a real verification. Used when there is no real hash to check. */
  async dummyVerify(): Promise<void> {
    this.dummyHash ??= this.hash('clinik-os-timing-equalisation-password');
    await this.verify(await this.dummyHash, 'clinik-os-timing-equalisation-wrong');
  }

  checkPolicy(plain: string, context: { email: string; fullName: string }): PasswordPolicyResult {
    const length = [...plain].length; // code points, not UTF-16 units
    if (length < PASSWORD_MIN_LENGTH) return 'PASSWORD_TOO_SHORT';
    if (length > PASSWORD_MAX_LENGTH) return 'PASSWORD_TOO_LONG';
    const lowered = plain.toLowerCase();
    if (this.common.has(lowered)) return 'PASSWORD_TOO_COMMON';
    const email = context.email.trim().toLowerCase();
    const localPart = email.split('@')[0] ?? '';
    if (
      (email.length > 0 && lowered.includes(email)) ||
      (localPart.length >= MIN_EMAIL_LOCAL_PART_LENGTH && lowered.includes(localPart))
    ) {
      return 'PASSWORD_CONTAINS_EMAIL';
    }
    // context.fullName is accepted for forward compatibility; no name rule is approved (v1.2).
    return 'ok';
  }
}
