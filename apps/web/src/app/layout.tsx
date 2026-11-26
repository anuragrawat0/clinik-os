import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import { ScrubCredentialUrl } from '@/components/auth/scrub-credential-url';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Clinik OS',
  description: 'Clinic operations platform foundation',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <Suspense fallback={null}>
          <ScrubCredentialUrl />
        </Suspense>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
