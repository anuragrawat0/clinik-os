'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client/client';
import { checkResponse, displayError, problemMessage } from '@/lib/api-client/problems';
import { useSingleFlightSubmit } from '@/lib/use-single-flight-submit';
import { useHydrated } from './use-hydrated';

type FormMode = 'login' | 'forgot' | 'reset';
const titles = { login: 'Sign in', forgot: 'Forgot password', reset: 'Reset password' };
const actions = { login: 'Sign in', forgot: 'Send reset link', reset: 'Save new password' };

export function AuthForm({
  mode,
  token,
  sessionEnded = false,
}: {
  mode: FormMode;
  token?: string;
  sessionEnded?: boolean;
}) {
  const router = useRouter();
  const cache = useQueryClient();
  const hydrated = useHydrated();
  const runSubmit = useSingleFlightSubmit();
  const [complete, setComplete] = useState(false);
  const task = useMutation({
    gcTime: 0,
    mutationFn: async (data: FormData) => {
      const email = String(data.get('email') ?? '');
      const password = String(data.get('password') ?? '');
      const { response, error } =
        mode === 'login'
          ? await apiClient.POST('/api/v1/auth/login', { body: { email, password } })
          : mode === 'forgot'
            ? await apiClient.POST('/api/v1/auth/password/forgot', { body: { email } })
            : await apiClient.POST('/api/v1/auth/password/reset', {
                body: { token: token ?? '', password },
              });
      checkResponse(response, error);
    },
    onSuccess: () => {
      if (mode === 'login') {
        cache.clear();
        router.replace('/app');
      } else {
        setComplete(true);
      }
    },
  });

  return (
    <>
      <h1 id="auth-title">{titles[mode]}</h1>
      {sessionEnded && <p role="status">{problemMessage({ code: 'UNAUTHENTICATED' })}</p>}
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
        <form
          className="auth-form"
          method="post"
          aria-busy={task.isPending}
          onSubmit={(event) => {
            event.preventDefault();
            if (!hydrated || task.isPending) return;
            void runSubmit(() => task.mutateAsync(new FormData(event.currentTarget)));
          }}
        >
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
          {task.isError && (
            <p role="alert" className="auth-error">
              {displayError(task.error)}
            </p>
          )}
          <Button type="submit" disabled={!hydrated || task.isPending}>
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
