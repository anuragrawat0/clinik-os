'use client';

import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client/client';

export function HealthStatus() {
  const health = useQuery({
    queryKey: ['system-health'],
    queryFn: async () => {
      const result = await apiClient.GET('/api/v1/health');
      if (result.error || !result.data) {
        throw new Error('The API health endpoint did not return a healthy response.');
      }
      return result.data;
    },
  });

  const isHealthy = health.data?.status === 'ok' && health.data.database === 'ok';

  return (
    <div className="status-card" aria-live="polite">
      <span className={`status-dot ${isHealthy ? 'status-dot--ready' : ''}`} />
      <div>
        <p className="status-card__label">Development services</p>
        <p className="status-card__value">
          {health.isPending
            ? 'Checking API and database…'
            : isHealthy
              ? 'API and database are ready'
              : 'API health check unavailable'}
        </p>
      </div>
    </div>
  );
}
