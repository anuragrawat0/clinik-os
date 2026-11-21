'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client/client';

export function VerifyEmailForm({ token }: { token?: string }) {
  const [status, setStatus] = useState<'ready' | 'busy' | 'complete' | 'failed'>('ready');

  async function verify() {
    if (!token) return;
    setStatus('busy');
    try {
      const { response } = await apiClient.POST('/api/v1/auth/email/verify', { body: { token } });
      setStatus(response.ok ? 'complete' : 'failed');
    } catch {
      setStatus('failed');
    }
  }

  return (
    <>
      <h1 id="auth-title">Verify email</h1>
      {!token && (
        <p className="auth-error" role="alert">
          This verification link is unavailable.
        </p>
      )}
      {status === 'complete' && <p role="status">Your email is verified.</p>}
      {status === 'failed' && (
        <p className="auth-error" role="alert">
          Unable to verify your email. Check the link and try again.
        </p>
      )}
      {token && status !== 'complete' && (
        <Button type="button" onClick={verify} disabled={status === 'busy'}>
          Verify email
        </Button>
      )}
      <Link href="/login">Back to sign in</Link>
    </>
  );
}
