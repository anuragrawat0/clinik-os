import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

export interface GeneratedToken {
  /** Handed to the user once (cookie or emailed link). Never stored, never logged. */
  raw: string;
  /** sha256(raw); the only form persisted. */
  hash: Buffer;
}

@Injectable()
export class TokenService {
  generate(): GeneratedToken {
    const raw = randomBytes(32).toString('base64url');
    return { raw, hash: this.hash(raw) };
  }

  hash(raw: string): Buffer {
    return createHash('sha256').update(raw, 'utf8').digest();
  }
}
