import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadApiConfig } from '../../src/core/config/config';
import { ClientIpResolver } from '../../src/modules/identity/core/client-ip-resolver';
import { IpRateLimiter } from '../../src/modules/identity/core/ip-rate-limiter';
import { TokenService } from '../../src/modules/identity/core/token.service';
import { FakeClock, MINUTE } from '../helpers/fake-clock';

describe('TokenService', () => {
  const tokens = new TokenService();

  it('generates 32 random bytes as base64url with a sha256 hash', () => {
    const { raw, hash } = tokens.generate();
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(raw, 'base64url')).toHaveLength(32);
    expect(hash).toEqual(createHash('sha256').update(raw).digest());
    expect(tokens.hash(raw)).toEqual(hash);
  });

  it('never repeats across many generations', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => tokens.generate().raw));
    expect(seen.size).toBe(2000);
  });
});

describe('IpRateLimiter', () => {
  it('limits each bucket per IP and reports retryAfterSec', () => {
    const clock = new FakeClock();
    const limiter = new IpRateLimiter(clock);

    for (let i = 0; i < 20; i += 1)
      expect(limiter.consume('login', '1.1.1.1')).toEqual({ allowed: true });
    const blocked = limiter.consume('login', '1.1.1.1');
    expect(blocked).toEqual({ allowed: false, retryAfterSec: 60 });
    // another IP and another bucket are independent
    expect(limiter.consume('login', '2.2.2.2')).toEqual({ allowed: true });
    expect(limiter.consume('token-verify', '1.1.1.1')).toEqual({ allowed: true });

    clock.advance(45_000);
    expect(limiter.consume('login', '1.1.1.1')).toEqual({ allowed: false, retryAfterSec: 15 });
    clock.advance(15_000);
    expect(limiter.consume('login', '1.1.1.1')).toEqual({ allowed: true });
  });

  it('enforces 5 per 15 minutes for password-forgot and 30 per minute for token-verify', () => {
    const clock = new FakeClock();
    const limiter = new IpRateLimiter(clock);
    for (let i = 0; i < 5; i += 1)
      expect(limiter.consume('password-forgot', '3.3.3.3').allowed).toBe(true);
    expect(limiter.consume('password-forgot', '3.3.3.3')).toEqual({
      allowed: false,
      retryAfterSec: 15 * 60,
    });
    clock.advance(15 * MINUTE);
    expect(limiter.consume('password-forgot', '3.3.3.3').allowed).toBe(true);

    for (let i = 0; i < 30; i += 1)
      expect(limiter.consume('token-verify', '4.4.4.4').allowed).toBe(true);
    expect(limiter.consume('token-verify', '4.4.4.4').allowed).toBe(false);
  });
});

describe('ClientIpResolver', () => {
  const request = (peer: string | undefined, forwarded?: string | string[]) => ({
    socket: { remoteAddress: peer },
    headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded },
  });

  it('ignores X-Forwarded-For when the peer is not a trusted proxy (spoofing)', () => {
    const resolver = new ClientIpResolver(['172.16.0.0/12']);
    expect(resolver.resolve(request('203.0.113.9', '6.6.6.6'))).toBe('203.0.113.9');
  });

  it('ignores X-Forwarded-For entirely when no proxy is configured', () => {
    const resolver = new ClientIpResolver([]);
    expect(resolver.resolve(request('172.18.0.5', '198.51.100.7'))).toBe('172.18.0.5');
  });

  it('uses the right-most untrusted entry when the peer is a trusted proxy', () => {
    const resolver = new ClientIpResolver(['172.16.0.0/12', '10.0.0.1']);
    expect(resolver.resolve(request('172.18.0.5', '198.51.100.7'))).toBe('198.51.100.7');
    // client-supplied junk to the left of the real client is ignored
    expect(resolver.resolve(request('172.18.0.5', '6.6.6.6, 198.51.100.7'))).toBe('198.51.100.7');
    // chain of trusted proxies
    expect(resolver.resolve(request('172.18.0.5', '198.51.100.7, 10.0.0.1'))).toBe('198.51.100.7');
    // repeated header lines are joined
    expect(resolver.resolve(request('172.18.0.5', ['198.51.100.7', '10.0.0.1']))).toBe(
      '198.51.100.7',
    );
  });

  it('falls back to the proxy address when the header is missing or malformed', () => {
    const resolver = new ClientIpResolver(['172.16.0.0/12']);
    expect(resolver.resolve(request('172.18.0.5'))).toBe('172.18.0.5');
    expect(resolver.resolve(request('172.18.0.5', 'not-an-ip'))).toBe('172.18.0.5');
  });

  it('normalises IPv4-mapped IPv6 peers and supports IPv6 proxies', () => {
    const resolver = new ClientIpResolver(['172.16.0.0/12', 'fd00::/8']);
    expect(resolver.resolve(request('::ffff:172.18.0.5', '198.51.100.7'))).toBe('198.51.100.7');
    expect(resolver.resolve(request('fd00::5', '2001:db8::1'))).toBe('2001:db8::1');
    expect(resolver.resolve(request(undefined))).toBeNull();
  });
});

describe('TRUSTED_PROXY_CIDRS config', () => {
  const base = { DATABASE_URL: 'postgresql://clinic_app:dev@db/clinik' };

  it('defaults to trusting nobody and parses a comma-separated list', () => {
    expect(loadApiConfig(base).TRUSTED_PROXY_CIDRS).toEqual([]);
    expect(
      loadApiConfig({ ...base, TRUSTED_PROXY_CIDRS: '172.16.0.0/12, 10.0.0.1,fd00::/8' })
        .TRUSTED_PROXY_CIDRS,
    ).toEqual(['172.16.0.0/12', '10.0.0.1', 'fd00::/8']);
  });

  it('rejects malformed entries', () => {
    expect(() => loadApiConfig({ ...base, TRUSTED_PROXY_CIDRS: 'nope' })).toThrow();
    expect(() => loadApiConfig({ ...base, TRUSTED_PROXY_CIDRS: '10.0.0.0/33' })).toThrow();
  });
});
