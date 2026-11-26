import createClient from 'openapi-fetch';
import { sessionEndedPath } from './problems';
import type { paths } from './schema';

export const apiClient = createClient<paths>({
  baseUrl: '/',
  credentials: 'same-origin',
  headers: { 'X-Requested-With': 'XMLHttpRequest' },
});

apiClient.use({
  onResponse({ schemaPath, response }) {
    if (
      response.status === 401 &&
      /^\/api\/v1\/(orgs|admin)\//.test(schemaPath) &&
      typeof window !== 'undefined'
    ) {
      window.location.replace(sessionEndedPath);
    }
  },
});
