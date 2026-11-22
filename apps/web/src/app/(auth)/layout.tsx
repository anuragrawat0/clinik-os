import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import './auth.css';

export const metadata: Metadata = { referrer: 'no-referrer' };

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-shell">
      <div className="auth-shell__inner">
        <Link className="brand auth-brand" href="/">
          <span className="brand__mark" aria-hidden="true">
            C
          </span>
          Clinik OS
        </Link>
        <section className="auth-card" aria-labelledby="auth-title">
          {children}
        </section>
      </div>
    </main>
  );
}
