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

  it('validates the SMTP configuration and mail link origin', () => {
    const env = { DATABASE_URL: 'postgresql://clinic_app:dev@db/clinik' };
    expect(loadApiConfig(env)).toMatchObject({
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: 1025,
      MAIL_FROM: 'no-reply@clinik.test',
      APP_BASE_URL: 'http://127.0.0.1:3000',
    });
    for (const entry of [
      { SMTP_HOST: ' ' },
      { SMTP_PORT: '65536' },
      { MAIL_FROM: 'bad-address' },
      { APP_BASE_URL: 'file:///tmp' },
      { APP_BASE_URL: 'https://user@clinic.test' },
      { APP_BASE_URL: 'https://clinic.test/path' },
    ]) {
      expect(() => loadApiConfig({ ...env, ...entry })).toThrow();
    }
  });
});
