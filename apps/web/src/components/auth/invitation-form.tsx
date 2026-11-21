'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client/client';

export function InvitationForm({ token }: { token: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const params = { path: { token } };
  const preview = useQuery({
    queryKey: ['invitation', token],
    gcTime: 0,
    retry: false,
    queryFn: async ({ signal }) => {
      const { data } = await apiClient.GET('/api/v1/auth/invitations/{token}', { params, signal });
      if (!data) throw new Error('Invitation unavailable');
      return data;
    },
  });

  async function accept(values?: FormData) {
    setBusy(true);
    setFailed(false);
    try {
      const password = String(values?.get('password') ?? '');
      if (values && mode === 'existing' && preview.data) {
        const login = await apiClient.POST('/api/v1/auth/login', {
          body: { email: preview.data.email, password },
        });
        if (!login.response.ok) {
          setFailed(true);
          return;
        }
      }
      const body =
        values && mode === 'new'
          ? { fullName: String(values.get('fullName') ?? ''), password }
          : {};
      const { response } = await apiClient.POST('/api/v1/auth/invitations/{token}/accept', {
        params,
        body,
      });
      if (response.ok) router.replace('/app');
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void accept(new FormData(event.currentTarget));
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
          <form key={mode} className="auth-form" onSubmit={submit} aria-busy={busy}>
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
            {failed && (
              <p role="alert" className="auth-error">
                Unable to accept this invitation. Check your details and try again.
              </p>
            )}
            <Button type="submit" disabled={busy}>
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
                setFailed(false);
              }}
            >
              {mode === 'new' ? 'I already have an account' : 'I need to create an account'}
            </Button>
            {mode === 'existing' && (
              <Button type="button" tone="quiet" disabled={busy} onClick={() => void accept()}>
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
