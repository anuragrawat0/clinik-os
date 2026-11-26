'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useLayoutEffect } from 'react';

const credentialParams = new Set(['password', 'email', 'token']);
// The reset and verification pages have already read their token from route props.
const authQueryAllowlist = new Map<string, readonly string[]>([
  ['/login', ['reason', 'next']],
  ['/reset-password', []],
  ['/verify-email', []],
  ['/forgot-password', []],
  ['/invite', []],
]);
const invitationLink = /^\/invite\/[^/]+\/?$/;

function isSameOriginPath(value: string, origin: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || !URL.canParse(value, origin))
    return false;
  const destination = new URL(value, origin);
  return destination.origin === origin && destination.pathname === value;
}

export function ScrubCredentialUrl() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useLayoutEffect(() => {
    const url = new URL(window.location.href);
    const isInvitationLink = invitationLink.test(url.pathname);
    const authPage = isInvitationLink ? '/invite' : url.pathname.replace(/\/$/, '');
    const allowed = authQueryAllowlist.get(authPage);
    for (const name of new Set(url.searchParams.keys())) {
      if (!allowed) {
        if (credentialParams.has(name.toLowerCase())) url.searchParams.delete(name);
        continue;
      }
      const values = url.searchParams.getAll(name);
      const valid =
        allowed.includes(name) &&
        values.length === 1 &&
        (name === 'reason'
          ? values[0] === 'session-ended'
          : isSameOriginPath(values[0], url.origin));
      if (!valid) url.searchParams.delete(name);
    }
    if (isInvitationLink) url.pathname = '/invite';
    if (url.href !== window.location.href) {
      // Preserve Next's current route tree so the mounted invitation keeps its token.
      window.history.replaceState(window.history.state, '', url);
    }
  }, [pathname, searchParams]);

  return null;
}
