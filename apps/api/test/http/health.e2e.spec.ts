import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HealthController } from '../../src/core/health/health.controller';
import { DATABASE } from '../../src/core/db/database.module';
import { logger } from '../../src/core/logging/logger';
import { configureHttpApp } from '../../src/http-app';

describe('GET /api/v1/health', () => {
  let app: INestApplication;
  const database = { check: vi.fn<() => Promise<void>>() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: DATABASE, useValue: database }],
    }).compile();
    app = moduleRef.createNestApplication();
    vi.stubEnv('ENABLE_SWAGGER', undefined);
    try {
      configureHttpApp(app);
    } finally {
      vi.unstubAllEnvs();
    }
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports a healthy API and database with a request id', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(response.body).toEqual({ status: 'ok', database: 'ok' });
    expect(response.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    expect(response.headers['cache-control']).toBeUndefined();
    expect(response.headers.etag).toBeUndefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns generic problem+json when the database check fails', async () => {
    database.check.mockRejectedValueOnce(new Error('synthetic patient data must not leak'));
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(500);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({
      type: 'about:blank',
      status: 500,
      code: 'REQUEST_FAILED',
    });
    expect(JSON.stringify(response.body)).not.toContain('synthetic patient data');
  });

  it('does not register Swagger routes by default', async () => {
    await request(app.getHttpServer()).get('/api/docs').expect(404);
    await request(app.getHttpServer()).get('/api/docs-json').expect(404);
  });

  it('registers Swagger routes when explicitly enabled', async () => {
    const moduleRef = await Test.createTestingModule({}).compile();
    const enabledApp = moduleRef.createNestApplication();
    vi.stubEnv('ENABLE_SWAGGER', 'true');
    try {
      configureHttpApp(enabledApp);
      await enabledApp.init();
      await request(enabledApp.getHttpServer()).get('/api/docs/').expect(200);
      await request(enabledApp.getHttpServer()).get('/api/docs-json').expect(200);
    } finally {
      vi.unstubAllEnvs();
      await enabledApp.close();
    }
  });

  it('sends no-store and nosniff even for an unhandled API route', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/missing').expect(404);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers.etag).toBeUndefined();
  });

  it('logs system codes for unexpected errors without their messages', async () => {
    database.check.mockRejectedValueOnce(
      Object.assign(new TypeError('private synthetic error detail'), { code: 'ECONNRESET' }),
    );
    const log = vi.spyOn(logger, 'error');
    try {
      const response = await request(app.getHttpServer()).get('/api/v1/health').expect(500);
      expect(log).toHaveBeenCalledWith(
        {
          requestId: response.body.requestId,
          errorClass: 'TypeError',
          code: 'ECONNRESET',
          constraint: undefined,
        },
        'HTTP request failed',
      );
      const failures = log.mock.calls.filter(([, message]) => message === 'HTTP request failed');
      expect(JSON.stringify(failures)).not.toContain('private synthetic error detail');
    } finally {
      log.mockRestore();
    }
  });
});
