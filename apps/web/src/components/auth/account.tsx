'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client/client';

export function Account() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [leaving, setLeaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const account = useQuery({
    queryKey: ['auth', 'me'],
    gcTime: 0,
    retry: false,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const { data, response } = await apiClient.GET('/api/v1/auth/me', { signal });
      if (response.status === 401) return null;
      if (!data) throw new Error('Account unavailable');
      return data;
    },
  });

  async function logout() {
    setLeaving(true);
    setFailed(false);
    try {
      const { response } = await apiClient.POST('/api/v1/auth/logout');
      if (response.ok || response.status === 401) {
        await queryClient.cancelQueries({ queryKey: ['auth', 'me'] });
        queryClient.setQueryData(['auth', 'me'], null);
        router.replace('/login');
      } else {
        setFailed(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setLeaving(false);
    }
  }

  return (
    <>
      <h1 id="auth-title">Your account</h1>
      {account.isPending && <p role="status">Loading your account…</p>}
      {account.isError && (
        <p className="auth-error" role="alert">
          Unable to load your account. Please try again.
        </p>
      )}
      {(account.data === null || account.isError) && <Link href="/login">Sign in</Link>}
      {account.data && (
        <>
          <dl className="auth-details">
            <div>
              <dt>Name</dt>
              <dd>{account.data.user.fullName}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd>{account.data.user.email}</dd>
            </div>
          </dl>
          {account.data.memberships.length > 0 && (
            <ul aria-label="Organization memberships" className="auth-memberships">
              {account.data.memberships.map((membership) => (
                <li key={membership.organizationId}>
                  {membership.organizationName}
                  {membership.roles.length > 0 && (
                    <>
                      {' '}
                      · {membership.roles.map(({ role }) => role.replaceAll('_', ' ')).join(', ')}
                    </>
                  )}
                  {membership.status === 'suspended' ||
                  membership.organizationStatus === 'suspended'
                    ? ' (suspended)'
                    : null}
                </li>
              ))}
            </ul>
          )}
          {failed && (
            <p role="alert" className="auth-error">
              Unable to log out. Please try again.
            </p>
          )}
          <Button type="button" disabled={leaving} onClick={logout}>
            Logout
          </Button>
        </>
      )}
    </>
  );
}
