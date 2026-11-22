'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client/client';

type FormMode = 'login' | 'forgot' | 'reset';

const titles = { login: 'Sign in', forgot: 'Forgot password', reset: 'Reset password' };
const actions = { login: 'Sign in', forgot: 'Send reset link', reset: 'Save new password' };
const failureMessages = {
  login: 'Unable to sign in. Check your details and try again.',
  forgot: 'Unable to submit the request. Please try again.',
  reset: 'Unable to reset your password. Check the link and try again.',
};

export function AuthForm({ mode, token }: { mode: FormMode; token?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '');
    const password = String(data.get('password') ?? '');
    setBusy(true);
    setFailed(false);
    try {
      const { response } =
        mode === 'login'
          ? await apiClient.POST('/api/v1/auth/login', { body: { email, password } })
          : mode === 'forgot'
            ? await apiClient.POST('/api/v1/auth/password/forgot', { body: { email } })
            : await apiClient.POST('/api/v1/auth/password/reset', {
                body: { token: token ?? '', password },
              });
      if (!response.ok) {
        setFailed(true);
      } else if (mode === 'login') {
        router.replace('/app');
      } else {
        setComplete(true);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 id="auth-title">{titles[mode]}</h1>
      {complete ? (
        <p role="status">
          {mode === 'forgot'
            ? 'If an account matches that email, we’ll send you a link to reset your password.'
            : 'Your password was updated. You can now sign in.'}
        </p>
      ) : mode === 'reset' && !token ? (
        <p role="alert" className="auth-error">
          This password reset link is unavailable.
        </p>
      ) : (
        <form className="auth-form" onSubmit={submit} aria-busy={busy}>
          {mode !== 'reset' && (
            <label className="auth-field">
              Email
              <input type="email" name="email" autoComplete="username" maxLength={254} required />
            </label>
          )}
          {mode !== 'forgot' && (
            <label className="auth-field">
              {mode === 'reset' ? 'New password' : 'Password'}
              <input
                type="password"
                name="password"
                autoComplete={mode === 'reset' ? 'new-password' : 'current-password'}
                required
              />
            </label>
          )}
          {mode === 'reset' && <p>Use a unique password with 12 to 128 characters.</p>}
          {failed && (
            <p role="alert" className="auth-error">
              {failureMessages[mode]}
            </p>
          )}
          <Button type="submit" disabled={busy}>
            {actions[mode]}
          </Button>
        </form>
      )}
      {mode === 'login' ? (
        <Link href="/forgot-password">Forgot your password?</Link>
      ) : (
        <Link href="/login">Back to sign in</Link>
      )}
    </>
  );
}
