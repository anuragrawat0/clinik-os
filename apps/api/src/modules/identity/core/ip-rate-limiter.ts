import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../core/clock/clock';
import {
  DEFAULT_RATE_LIMITS,
  type RateLimitBucket,
  type RateLimitRule,
} from './identity.constants';

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSec: number };

interface Window {
  startedAt: number;
  count: number;
}

const SWEEP_THRESHOLD = 10_000;

/** In-memory fixed-window limiter. Correct only for a single API instance (D12). */
@Injectable()
export class IpRateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly rules: Readonly<Record<RateLimitBucket, RateLimitRule>> = DEFAULT_RATE_LIMITS;

  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  consume(bucket: RateLimitBucket, ip: string | null): RateLimitResult {
    const rule = this.rules[bucket];
    const now = this.clock.now().getTime();
    if (this.windows.size > SWEEP_THRESHOLD) this.sweep(now);

    const key = `${bucket}|${ip ?? 'unknown'}`;
    const current = this.windows.get(key);
    if (!current || now - current.startedAt >= rule.windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return { allowed: true };
    }
    if (current.count >= rule.limit) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((current.startedAt + rule.windowMs - now) / 1000)),
      };
    }
    current.count += 1;
    return { allowed: true };
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) {
      const bucket = key.slice(0, key.indexOf('|')) as RateLimitBucket;
      if (now - window.startedAt >= this.rules[bucket].windowMs) this.windows.delete(key);
    }
  }
}
