import Link from 'next/link';
import { HealthStatus } from '@/components/health-status';

export default function HomePage() {
  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Clinik OS home">
          <span className="brand__mark" aria-hidden="true">
            C
          </span>
          <span>Clinik OS</span>
        </a>
        <span className="topbar__tag">FOUNDATIONS</span>
      </header>

      <section className="welcome-panel" aria-labelledby="welcome-title">
        <p className="eyebrow">Clinic operations, connected</p>
        <h1 id="welcome-title">A clearer workspace for clinic teams.</h1>
        <p className="welcome-panel__copy">
          The Clinik OS foundation is running. This shell will grow into a shared workspace for
          appointments, records, and the day-to-day work around patient care.
        </p>
        <div className="welcome-panel__actions">
          <Link className="button button--primary home-sign-in" href="/login">
            Sign in
          </Link>
          <span className="build-label">M0 · Foundations</span>
        </div>
      </section>

      <section className="foundation-grid" aria-label="Foundation status">
        <article className="foundation-card foundation-card--accent">
          <p className="foundation-card__index">01 / PLATFORM</p>
          <h2>One connected system</h2>
          <p>Web, API, worker, and PostgreSQL share one modular application foundation.</p>
        </article>
        <article className="foundation-card">
          <p className="foundation-card__index">02 / SAFETY</p>
          <h2>Tenant-aware by design</h2>
          <p>Database work can run inside transaction-local organization context.</p>
        </article>
        <article className="foundation-card">
          <p className="foundation-card__index">03 / DELIVERY</p>
          <h2>Ready to build</h2>
          <p>The development services and checks are in place for the next milestone.</p>
        </article>
      </section>

      <footer className="page-footer">
        <HealthStatus />
        <span>Clinik OS · Local development</span>
      </footer>
    </main>
  );
}
