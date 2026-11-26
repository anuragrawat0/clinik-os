import type { NextConfig } from 'next';

const apiOrigin = process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001';

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  async headers() {
    return ['/reset-password', '/invite/:path*', '/verify-email'].map((source) => ({
      source,
      headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
    }));
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

export default nextConfig;
