import { describe, expect, it } from 'vitest';
import { loadApiConfig, loadSwaggerEnabled, loadWorkerConfig } from '../../src/core/config/config';

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

  it('defaults and validates both runtime database timeout configurations', () => {
    const api = { DATABASE_URL: 'postgresql://clinic_app:dev@db/clinik' };
    const worker = { WORKER_DATABASE_URL: 'postgresql://clinic_worker:dev@db/clinik' };
    const defaults = {
      DB_POOL_ACQUIRE_TIMEOUT_MS: 5_000,
      DB_STATEMENT_TIMEOUT_MS: 10_000,
      DB_IDLE_IN_TX_TIMEOUT_MS: 15_000,
    };
    expect(loadApiConfig(api)).toMatchObject(defaults);
    expect(loadWorkerConfig(worker)).toMatchObject(defaults);
    for (const key of Object.keys(defaults)) {
      expect(() => loadApiConfig({ ...api, [key]: '0' })).toThrow();
      expect(() => loadWorkerConfig({ ...worker, [key]: '5.5' })).toThrow();
      expect(loadApiConfig({ ...api, [key]: '100' })).toMatchObject({ [key]: 100 });
    }
  });

  it('defaults Swagger to disabled', () => {
    const env = { DATABASE_URL: 'postgresql://clinic_app:dev@db/clinik' };
    expect(loadApiConfig(env).ENABLE_SWAGGER).toBe(false);
    expect(loadSwaggerEnabled(env)).toBe(false);
  });

  it.each([
    ['true', true],
    ['false', false],
    ['1', true],
    ['0', false],
    ['TrUe', true],
    ['FaLsE', false],
  ])('parses ENABLE_SWAGGER=%s as %s', (value, expected) => {
    const env = { DATABASE_URL: 'postgresql://clinic_app:dev@db/clinik', ENABLE_SWAGGER: value };
    expect(loadApiConfig(env).ENABLE_SWAGGER).toBe(expected);
    expect(loadSwaggerEnabled(env)).toBe(expected);
  });

  it.each(['', '2', 'yes', ' true '])('rejects unsupported ENABLE_SWAGGER=%j', (value) => {
    const env = { DATABASE_URL: 'postgresql://clinic_app:dev@db/clinik', ENABLE_SWAGGER: value };
    expect(() => loadApiConfig(env)).toThrow();
    expect(() => loadSwaggerEnabled(env)).toThrow();
  });
});
