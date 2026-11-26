'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { useMe, useLogout } from '@/features/m1/session';
import { clinicPath } from '@/features/m1/shell';
import { displayError, sessionEndedPath } from '@/lib/api-client/problems';

export function Account() {
  const router = useRouter();
  const account = useMe();
  const logout = useLogout();
  const data = account.data;
  const target =
    data === null
      ? sessionEndedPath
      : data?.user.isPlatformAdmin
        ? '/admin/organizations'
        : data?.memberships.length === 1
          ? clinicPath(data.memberships[0].organizationSlug)
          : null;

  useEffect(() => {
    if (target && !account.isFetching) router.replace(target);
  }, [account.isFetching, router, target]);

  if (account.isPending || target)
    return (
      <>
        <h1 id="auth-title">Your account</h1>
        <p role="status">Loading your workspace…</p>
      </>
    );

  return (
    <>
      <h1 id="auth-title">
        {data && data.memberships.length > 1 ? 'Choose a clinic' : 'Your account'}
      </h1>
      {account.isError && (
        <p role="alert" className="auth-error">
          {displayError(account.error)}
        </p>
      )}
      {account.isError && <Link href="/login">Sign in</Link>}
      {data &&
        (data.memberships.length > 1 ? (
          <ul className="auth-memberships" aria-label="Your clinics">
            {data.memberships.map((membership) => (
              <li key={membership.organizationId}>
                <Link href={clinicPath(membership.organizationSlug)}>
                  {membership.organizationName}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <dl className="auth-details">
            <div>
              <dt>Name</dt>
              <dd>{data.user.fullName}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{data.user.email}</dd>
            </div>
          </dl>
        ))}
      {logout.isError && (
        <p className="auth-error" role="alert">
          {displayError(logout.error)}
        </p>
      )}
      {data && (
        <Button type="button" disabled={logout.isPending} onClick={() => logout.mutate()}>
          Sign out
        </Button>
      )}
    </>
  );
}
