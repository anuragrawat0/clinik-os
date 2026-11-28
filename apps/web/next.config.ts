import type { NextConfig } from 'next';
import { PHASE_DEVELOPMENT_SERVER } from 'next/constants';

const apiOrigin = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001';

export default function nextConfig(phase: string): NextConfig {
  const scriptSrc =
    "script-src 'self' 'unsafe-inline'" +
    (phase === PHASE_DEVELOPMENT_SERVER ? " 'unsafe-eval'" : '');
  const contentSecurityPolicy = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
  return {
    poweredByHeader: false,
    allowedDevOrigins: ['127.0.0.1'],
    async headers() {
      return [
        {
          source: '/:path*',
          headers: [
            { key: 'Content-Security-Policy', value: contentSecurityPolicy },
            { key: 'X-Frame-Options', value: 'DENY' },
            { key: 'X-Content-Type-Options', value: 'nosniff' },
            { key: 'Referrer-Policy', value: 'same-origin' },
            { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          ],
        },
        ...['/reset-password', '/invite/:path*', '/verify-email'].map((source) => ({
          source,
          headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
        })),
      ];
    },
    async rewrites() {
      return [
        {
          source: '/api/:path*',
          destination: `${apiOrigin}/api/:path*`,
        },
      ];
    },
  };
}
