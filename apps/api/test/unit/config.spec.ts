import { describe, expect, it } from 'vitest';
import { loadApiConfig, loadWorkerConfig } from '../../src/core/config/config';

describe('environment configuration', () => {
  it('requires a valid API database URL', () => {
    expect(() => loadApiConfig({ API_PORT: '3001' })).toThrow();
    expect(
      loadApiConfig({ API_PORT: '3001', DATABASE_URL: 'postgresql://clinic_app:dev@db/clinik' }),
    ).toMatchObject({ API_PORT: 3001 });
  });

  it('validates worker configuration separately from the API', () => {
    expect(() => loadWorkerConfig({ DATABASE_URL: 'postgresql://clinic_app@db/clinik' })).toThrow();
    expect(
      loadWorkerConfig({ WORKER_DATABASE_URL: 'postgresql://clinic_worker:dev@db/clinik' }),
    ).toMatchObject({ NODE_ENV: 'development' });
  });
});
