'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client/client';
import { checkResponse, displayError, responseData } from '@/lib/api-client/problems';
import { useSingleFlightSubmit } from '@/lib/use-single-flight-submit';
import { useHydrated } from './use-hydrated';

export function InvitationForm({ token }: { token: string }) {
  const router = useRouter();
  const cache = useQueryClient();
  const hydrated = useHydrated();
  const runSubmit = useSingleFlightSubmit();
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const params = { path: { token } };
  const preview = useQuery({
    queryKey: ['invitation', token],
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) =>
      responseData(await apiClient.GET('/api/v1/auth/invitations/{token}', { params, signal })),
  });

  const accept = useMutation({
    gcTime: 0,
    mutationFn: async (values: FormData | undefined) => {
      const password = String(values?.get('password') ?? '');
      if (values && mode === 'existing' && preview.data) {
        const login = await apiClient.POST('/api/v1/auth/login', {
          body: { email: preview.data.email, password },
        });
        checkResponse(login.response, login.error);
      }
      const body =
        values && mode === 'new'
          ? { fullName: String(values.get('fullName') ?? ''), password }
          : {};
      const { response, error } = await apiClient.POST('/api/v1/auth/invitations/{token}/accept', {
        params,
        body,
      });
      checkResponse(response, error);
    },
    onSuccess: () => {
      cache.clear();
      router.replace('/app');
    },
  });
  const busy = accept.isPending;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || busy) return;
    void runSubmit(() => accept.mutateAsync(new FormData(event.currentTarget)));
  }

  return (
    <>
      <h1 id="auth-title">Accept invitation</h1>
      {preview.isPending && <p role="status">Loading invitation…</p>}
      {preview.isError && (
        <p role="alert" className="auth-error">
          This invitation is unavailable.
        </p>
      )}
      {preview.data && (
        <>
          <dl className="auth-details">
            <div>
              <dt>Organization</dt>
              <dd>{preview.data.organizationName}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{preview.data.role.replaceAll('_', ' ')}</dd>
            </div>
            {preview.data.branchName && (
              <div>
                <dt>Branch</dt>
                <dd>{preview.data.branchName}</dd>
              </div>
            )}
            <div>
              <dt>Invited email</dt>
              <dd>{preview.data.email}</dd>
            </div>
          </dl>
          <form key={mode} className="auth-form" method="post" onSubmit={submit} aria-busy={busy}>
            {mode === 'new' ? (
              <label className="auth-field">
                Full name
                <input name="fullName" autoComplete="name" maxLength={200} required />
              </label>
            ) : (
              <label className="auth-field">
                Email
                <input
                  type="email"
                  name="email"
                  autoComplete="username"
                  value={preview.data.email}
                  readOnly
                />
              </label>
            )}
            <label className="auth-field">
              {mode === 'new' ? 'New password' : 'Password'}
              <input
                type="password"
                name="password"
                autoComplete={mode === 'new' ? 'new-password' : 'current-password'}
                required
              />
            </label>
            {mode === 'new' && <p>Use a unique password with 12 to 128 characters.</p>}
            {accept.isError && (
              <p role="alert" className="auth-error">
                {displayError(accept.error)}
              </p>
            )}
            <Button type="submit" disabled={!hydrated || busy}>
              {mode === 'new' ? 'Create account and accept' : 'Sign in and accept'}
            </Button>
          </form>
          <div className="auth-actions">
            <Button
              type="button"
              tone="quiet"
              disabled={busy}
              onClick={() => {
                setMode(mode === 'new' ? 'existing' : 'new');
                accept.reset();
              }}
            >
              {mode === 'new' ? 'I already have an account' : 'I need to create an account'}
            </Button>
            {mode === 'existing' && (
              <Button
                type="button"
                tone="quiet"
                disabled={!hydrated || busy}
                onClick={() => void runSubmit(() => accept.mutateAsync(undefined))}
              >
                Accept with my current session
              </Button>
            )}
          </div>
        </>
      )}
      <Link href="/login">Back to sign in</Link>
    </>
  );
}
