'use client';

import { useRef } from 'react';

export function useSingleFlightSubmit() {
  const inFlight = useRef(false);
  return async (submit: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await submit();
    } catch {
      // The mutation's error state is rendered by the caller.
    } finally {
      inFlight.current = false;
    }
  };
}
