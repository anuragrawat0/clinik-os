import type { IncomingMessage } from 'node:http';

/** The TCP peer of the request, with an IPv4-mapped IPv6 prefix removed. */
export function peerAddress(request: Pick<IncomingMessage, 'socket'>): string | undefined {
  const address = request.socket.remoteAddress;
  if (!address) return undefined;
  return address.toLowerCase().startsWith('::ffff:') && address.includes('.')
    ? address.slice(7)
    : address;
}

/**
 * Makes the web container the only author of client-IP information. Anything the browser sent in
 * X-Forwarded-For / Forwarded / X-Real-IP is discarded and X-Forwarded-For is set to the address of
 * the TCP peer that actually connected. Next's /api rewrite then proxies the request to the API,
 * which trusts X-Forwarded-For only from this container's static address (TRUSTED_PROXY_CIDRS).
 */
export function applyPeerAsForwardedFor(
  request: Pick<IncomingMessage, 'headers' | 'socket'>,
): void {
  const peer = peerAddress(request);
  delete request.headers['forwarded'];
  delete request.headers['x-real-ip'];
  if (peer) request.headers['x-forwarded-for'] = peer;
  else delete request.headers['x-forwarded-for'];
}
