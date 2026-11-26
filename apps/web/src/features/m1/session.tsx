'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api-client/client';
import { checkResponse, responseData } from '@/lib/api-client/problems';

export const meKey = ['auth', 'me'] as const;

export function useMe() {
  return useQuery({
    queryKey: meKey,
    gcTime: 0,
    retry: false,
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const result = await apiClient.GET('/api/v1/auth/me', { signal });
      return result.response.status === 401 ? null : responseData(result);
    },
  });
}

export function useLogout() {
  const router = useRouter();
  const cache = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { response, error } = await apiClient.POST('/api/v1/auth/logout');
      if (response.status !== 401) checkResponse(response, error);
    },
    onSuccess: async () => {
      await cache.cancelQueries();
      cache.clear();
      router.replace('/login');
    },
  });
}
