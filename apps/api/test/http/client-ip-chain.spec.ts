import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyPeerAsForwardedFor, peerAddress } from '../../../web/server/peer-forwarding';
import { ClientIpResolver } from '../../src/modules/identity/core/client-ip-resolver';
import { IpRateLimiter } from '../../src/modules/identity/core/ip-rate-limiter';
import { FakeClock } from '../helpers/fake-clock';

/**
 * The deployed chain is: browser -> web (custom server overwrites X-Forwarded-For) -> Next's /api
 * rewrite proxy (forwards the sanitised header) -> API (ClientIpResolver trusting
 * only the web container's address). This test drives the real web-side function over a real socket
 * and feeds what the API would receive into the real resolver and limiter. The Compose smoke test
 * proves the same with the real Next proxy.
 */
const WEB_IP = '172.28.0.10';

describe('client IP: web server overwrite + API trust chain', () => {
  let server: Server;
  let port: number;
  const received: {
    xff: string | undefined;
    forwarded: string | undefined;
    realIp: string | undefined;
  }[] = [];
  const resolver = new ClientIpResolver([`${WEB_IP}/32`]);

  beforeAll(async () => {
    server = createServer((req, res) => {
      applyPeerAsForwardedFor(req);
      received.push({
        xff: req.headers['x-forwarded-for'] as string | undefined,
        forwarded: req.headers['forwarded'] as string | undefined,
        realIp: req.headers['x-real-ip'] as string | undefined,
      });
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function callWeb(headers: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, headers }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });
  }

  /** What the API receives. The Compose smoke showed Next's proxy forwards the header unchanged. */
  function apiView(): { socket: { remoteAddress: string }; headers: Record<string, string> } {
    return {
      socket: { remoteAddress: WEB_IP },
      headers: { 'x-forwarded-for': received.at(-1)?.xff ?? '' },
    };
  }

  it('discards a client-forged X-Forwarded-For, Forwarded and X-Real-IP and uses the real peer', async () => {
    await callWeb({
      'X-Forwarded-For': '6.6.6.6, 7.7.7.7',
      Forwarded: 'for=8.8.8.8',
      'X-Real-IP': '9.9.9.9',
    });
    expect(received.at(-1)).toEqual({ xff: '127.0.0.1', forwarded: undefined, realIp: undefined });
    expect(resolver.resolve(apiView())).toBe('127.0.0.1');
  });

  it('sets the real peer even when the client sent nothing', async () => {
    await callWeb({});
    expect(received.at(-1)?.xff).toBe('127.0.0.1');
  });

  it('rotating forged IPs cannot escape the login bucket', async () => {
    const limiter = new IpRateLimiter(new FakeClock());
    const results = [];
    for (let i = 0; i < 25; i += 1) {
      await callWeb({ 'X-Forwarded-For': `198.51.100.${i + 1}` });
      results.push(limiter.consume('login', resolver.resolve(apiView())));
    }
    expect(results.filter((r) => r.allowed)).toHaveLength(20);
    expect(results.slice(20).every((r) => !r.allowed)).toBe(true);
  });

  it('a forged X-Forwarded-For naming the proxy itself cannot collapse into the proxy bucket', async () => {
    for (const forged of [WEB_IP, `6.6.6.6, ${WEB_IP}`, `${WEB_IP}, ${WEB_IP}`]) {
      await callWeb({ 'X-Forwarded-For': forged });
      const ip = resolver.resolve(apiView());
      expect(ip).toBe('127.0.0.1');
      expect(ip).not.toBe(WEB_IP);
    }
  });

  it('a direct call from an untrusted peer cannot use X-Forwarded-For at all', () => {
    for (const peer of ['203.0.113.9', '172.28.0.11', '::ffff:172.28.0.99']) {
      const ip = resolver.resolve({
        socket: { remoteAddress: peer },
        headers: { 'x-forwarded-for': `6.6.6.6, ${WEB_IP}` },
      });
      expect(ip).toBe(peer.replace('::ffff:', ''));
    }
  });

  it('trust is exactly the web address: its /24 neighbours are not proxies', () => {
    const neighbour = resolver.resolve({
      socket: { remoteAddress: '172.28.0.11' },
      headers: { 'x-forwarded-for': '6.6.6.6' },
    });
    expect(neighbour).toBe('172.28.0.11');
  });

  it('strips an IPv4-mapped prefix from the peer', () => {
    expect(peerAddress({ socket: { remoteAddress: '::ffff:10.1.2.3' } } as never)).toBe('10.1.2.3');
    expect(peerAddress({ socket: { remoteAddress: '2001:db8::1' } } as never)).toBe('2001:db8::1');
    expect(peerAddress({ socket: {} } as never)).toBeUndefined();
  });
});
