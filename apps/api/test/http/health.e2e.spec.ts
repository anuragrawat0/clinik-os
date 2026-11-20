import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HealthController } from '../../src/core/health/health.controller';
import { DATABASE } from '../../src/core/db/database.module';
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
    configureHttpApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports a healthy API and database with a request id', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(response.body).toEqual({ status: 'ok', database: 'ok' });
    expect(response.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
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
});
