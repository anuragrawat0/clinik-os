'use client';

import { isStaffRole, type RoleScope } from '@clinik/shared';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { sessionEndedPath } from '@/lib/api-client/problems';
import type { components } from '@/lib/api-client/schema';
import { organizationNavigation } from './permissions';
import { useLogout, useMe } from './session';
import { LoadError, Notice, Unavailable } from './ui';

type Account = components['schemas']['MeResponseDto'];
type Membership = Account['memberships'][number];
const Clinic = createContext<{
  membership: Membership;
  roles: RoleScope[];
  user: Account['user'];
} | null>(null);

export const clinicPath = (slug: string) => `/o/${encodeURIComponent(slug)}`;

export function useClinic() {
  const value = useContext(Clinic);
  if (!value) throw new Error('Clinic workspace context is missing');
  return value;
}

function WorkspaceHeader({ account, selected }: { account: Account; selected?: string }) {
  const router = useRouter();
  const logout = useLogout();
  return (
    <header className="m1-top">
      <Link className="brand" href="/app">
        <span className="brand__mark" aria-hidden="true">
          C
        </span>
        Clinik OS
      </Link>
      <div className="m1-header-actions">
        {(account.memberships.length > 0 || selected) && (
          <label className="m1-switch">
            Switch clinic
            <select
              aria-label="Switch clinic"
              value={selected ?? ''}
              onChange={(event) => {
                if (event.target.value) router.push(clinicPath(event.target.value));
              }}
            >
              {!selected && <option value="">Choose a clinic</option>}
              {account.memberships.map((membership) => (
                <option key={membership.organizationId} value={membership.organizationSlug}>
                  {membership.organizationName}
                </option>
              ))}
            </select>
          </label>
        )}
        <details className="m1-user">
          <summary>{account.user.fullName}</summary>
          <div>
            <p>{account.user.email}</p>
            {account.user.isPlatformAdmin && (
              <Link href="/admin/organizations">Platform administration</Link>
            )}
            <Button
              type="button"
              tone="quiet"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              Sign out
            </Button>
            {logout.isError && <LoadError error={logout.error} />}
          </div>
        </details>
      </div>
    </header>
  );
}

function SignedIn({ children }: { children: (account: Account) => ReactNode }) {
  const router = useRouter();
  const account = useMe();
  useEffect(() => {
    if (account.data === null) router.replace(sessionEndedPath);
  }, [account.data, router]);

  return (
    <div className="m1-workspace">
      {account.data ? (
        children(account.data)
      ) : (
        <main className="m1-main">
          {account.isError ? (
            <LoadError error={account.error} />
          ) : (
            <Notice>Loading your workspace…</Notice>
          )}
        </main>
      )}
    </div>
  );
}

export function ClinicShell({ slug, children }: { slug: string; children: ReactNode }) {
  const pathname = usePathname();
  return (
    <SignedIn>
      {(account) => {
        const membership = account.memberships.find(
          ({ organizationSlug }) => organizationSlug === slug,
        );
        if (!membership)
          return (
            <>
              <WorkspaceHeader account={account} />
              <main className="m1-main">
                <Unavailable />
              </main>
            </>
          );
        const roles = membership.roles.flatMap(({ role, branchId }) =>
          isStaffRole(role) ? [{ role, branchId }] : [],
        );
        return (
          <Clinic.Provider value={{ membership, roles, user: account.user }}>
            <WorkspaceHeader account={account} selected={slug} />
            <div className="m1-columns">
              <aside className="m1-sidebar">
                <strong>{membership.organizationName}</strong>
                <nav aria-label="Clinic navigation">
                  {organizationNavigation(roles).map(({ path, label }) => {
                    const href = clinicPath(slug) + path;
                    return (
                      <Link
                        key={path}
                        href={href}
                        aria-current={href === pathname ? 'page' : undefined}
                      >
                        {label}
                      </Link>
                    );
                  })}
                </nav>
              </aside>
              <main className="m1-main">{children}</main>
            </div>
          </Clinic.Provider>
        );
      }}
    </SignedIn>
  );
}

export function PlatformShell({ children }: { children: ReactNode }) {
  return (
    <SignedIn>
      {(account) => (
        <>
          <WorkspaceHeader account={account} />
          <main className="m1-main m1-main--wide">
            {account.user.isPlatformAdmin ? children : <Unavailable />}
          </main>
        </>
      )}
    </SignedIn>
  );
}
