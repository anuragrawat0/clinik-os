'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useLayoutEffect } from 'react';

const credentialParams = new Set(['password', 'email', 'token']);

export function ScrubCredentialUrl() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useLayoutEffect(() => {
    const url = new URL(window.location.href);
    for (const name of Array.from(url.searchParams.keys())) {
      if (credentialParams.has(name.toLowerCase())) url.searchParams.delete(name);
    }
    // The token pages have already read their link tokens from route props.
    if (/^\/invite\/[^/]+\/?$/.test(url.pathname)) url.pathname = '/invite';
    if (url.href !== window.location.href) {
      // Preserve Next's current route tree so the mounted invitation keeps its token.
      window.history.replaceState(window.history.state, '', url);
    }
  }, [pathname, searchParams]);

  return null;
}
