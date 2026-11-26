'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client/client';
import { responseData } from '@/lib/api-client/problems';

export const clinicKey = (id: string) => ['clinic', id] as const;
export const clinicParams = (orgId: string) => ({ path: { orgId } });

export function useBranches(orgId: string, enabled = true) {
  return useQuery({
    queryKey: [...clinicKey(orgId), 'branches'],
    enabled,
    queryFn: async ({ signal }) =>
      responseData(
        await apiClient.GET('/api/v1/orgs/{orgId}/branches', {
          params: clinicParams(orgId),
          signal,
        }),
      ),
  });
}

export function useMembers(orgId: string, enabled = true) {
  return useQuery({
    queryKey: [...clinicKey(orgId), 'members'],
    enabled,
    queryFn: async ({ signal }) =>
      responseData(
        await apiClient.GET('/api/v1/orgs/{orgId}/members', {
          params: clinicParams(orgId),
          signal,
        }),
      ),
  });
}
