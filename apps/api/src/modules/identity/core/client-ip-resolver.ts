import { Inject, Injectable } from '@nestjs/common';
import { BlockList, isIP } from 'node:net';
import type { Request } from 'express';
import type { RequestMeta } from './types';

export const TRUSTED_PROXY_CIDRS = Symbol('TRUSTED_PROXY_CIDRS');

type RequestLike = Pick<Request, 'headers'> & { socket: { remoteAddress?: string | undefined } };

function normalise(address: string | undefined): string | null {
  if (!address) return null;
  let value = address.trim();
  if (value.toLowerCase().startsWith('::ffff:') && isIP(value.slice(7)) === 4) {
    value = value.slice(7);
  }
  const zone = value.indexOf('%');
  if (zone !== -1) value = value.slice(0, zone);
  return isIP(value) === 0 ? null : value;
}

function familyOf(address: string): 'ipv4' | 'ipv6' {
  return isIP(address) === 4 ? 'ipv4' : 'ipv6';
}

@Injectable()
export class ClientIpResolver {
  private readonly trusted = new BlockList();

  constructor(@Inject(TRUSTED_PROXY_CIDRS) cidrs: readonly string[]) {
    for (const entry of cidrs) {
      const [address, prefix] = entry.split('/');
      const normalised = normalise(address);
      if (!normalised) throw new Error(`Invalid TRUSTED_PROXY_CIDRS entry: ${entry}`);
      const family = familyOf(normalised);
      if (prefix === undefined) this.trusted.addAddress(normalised, family);
      else this.trusted.addSubnet(normalised, Number(prefix), family);
    }
  }

  private isTrusted(address: string): boolean {
    return this.trusted.check(address, familyOf(address));
  }

  /**
   * The socket peer, unless the peer is a trusted proxy. For a trusted peer the right-most
   * X-Forwarded-For entry that is not itself a trusted proxy is the client; anything the client
   * itself wrote sits to the left of that entry and is ignored.
   */
  resolve(request: RequestLike): string | null {
    const peer = normalise(request.socket.remoteAddress);
    if (!peer || !this.isTrusted(peer)) return peer;

    const header = request.headers['x-forwarded-for'];
    const joined = Array.isArray(header) ? header.join(',') : (header ?? '');
    const hops = joined
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    for (let index = hops.length - 1; index >= 0; index -= 1) {
      const hop = normalise(hops[index]);
      if (!hop) return peer; // malformed chain: do not guess, attribute to the proxy
      if (!this.isTrusted(hop)) return hop;
    }
    return peer;
  }
}

export function requestMetaFrom(
  request: RequestLike & { id?: unknown },
  resolver: ClientIpResolver,
): RequestMeta {
  const userAgent = request.headers['user-agent'];
  return {
    ip: resolver.resolve(request),
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 512) : null,
    requestId: typeof request.id === 'string' ? request.id : 'unknown',
  };
}
