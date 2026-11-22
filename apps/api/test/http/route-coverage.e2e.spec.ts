import 'reflect-metadata';
import { createRequire } from 'node:module';
import { Controller, Get, Post, RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IS_PUBLIC_KEY } from '../../src/core/auth/public.decorator';
import {
  collectMountedRoutes,
  findUndeclaredRoutes,
  type ExpressLayer,
} from '../helpers/express-routes';

/**
 * Every route that may be called without a session. Adding a public route must be a deliberate
 * edit of this list (reviewed in the PR), never an accident.
 */
const ALLOWED_PUBLIC_ROUTES = [
  'GET /api/v1/health',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/password/forgot',
  'POST /api/v1/auth/password/reset',
  'POST /api/v1/auth/email/verify',
  'GET /api/v1/auth/invitations/:token',
  'POST /api/v1/auth/invitations/:token/accept',
];

/**
 * Nest's own catch-all (registered in a nested router) that turns every unmatched path into a 404
 * through the exception filter. It has no handler of ours and returns no data; the test below
 * proves that. Nothing else may be mounted outside the controllers.
 */
const FRAMEWORK_ROUTES = ['_ALL <nested>*path'];

/**
 * Test-only controller added to the REAL application wiring. It is neither @Public nor guarded
 * explicitly, so the 401/403 assertions below prove the global guards cover controllers they were
 * not written for.
 */
@Controller('__probe')
class ProbeController {
  @Get('secure') read(): { ok: true } {
    return { ok: true };
  }
  @Post('secure') write(): { ok: true } {
    return { ok: true };
  }
}

interface RouteInfo {
  method: string;
  path: string;
  isPublic: boolean;
}

const methodNames: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

function joinPath(...parts: string[]): string {
  return (
    '/' +
    parts
      .map((part) => part.replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .join('/')
  );
}

describe('route coverage: every route is @Public or behind SessionGuard', () => {
  let app: INestApplication;
  let routes: RouteInfo[];

  beforeAll(async () => {
    process.env.DATABASE_URL = 'postgresql://clinic_app:test@127.0.0.1:1/none';
    const { AppModule } = await import('../../src/app.module');
    const { DATABASE } = await import('../../src/core/db/database.module');
    const { configureHttpApp } = await import('../../src/http-app');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    })
      .overrideProvider(DATABASE)
      .useValue({ check: async () => undefined, db: { transaction: async () => null } })
      .compile();
    app = moduleRef.createNestApplication();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; // no Swagger routes
    configureHttpApp(app);
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
    await app.init();

    routes = [];
    for (const nestModule of app.get(ModulesContainer).values()) {
      for (const wrapper of nestModule.controllers.values()) {
        const controller = wrapper.metatype as (new (...args: never[]) => object) | null;
        if (!controller) continue;
        const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
        const prototype = controller.prototype as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(prototype)) {
          const handler = prototype[name];
          if (typeof handler !== 'function' || name === 'constructor') continue;
          const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
          if (methodPath === undefined || method === undefined) continue;
          const isPublic =
            Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true ||
            Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true;
          routes.push({
            method: methodNames[method] ?? String(method),
            path: joinPath('api/v1', controllerPath ?? '', methodPath),
            isPublic,
          });
        }
      }
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('discovers the routes (guards against an empty enumeration passing vacuously)', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it('every Express route, at any router nesting depth, is a known controller route', () => {
    const expressApp = app.getHttpAdapter().getInstance() as { router: { stack: ExpressLayer[] } };
    const declared = new Set(routes.map((route) => `${route.method} ${route.path}`));
    expect(findUndeclaredRoutes(expressApp.router.stack, declared)).toEqual(FRAMEWORK_ROUTES);
    // and the walk saw exactly the declared routes plus the framework catch-all (not vacuous)
    expect(
      collectMountedRoutes(expressApp.router.stack)
        .map((route) => route.key)
        .sort(),
    ).toEqual([...declared, ...FRAMEWORK_ROUTES].sort());
  });

  it('the framework catch-all only ever answers a generic 404, with or without a session', async () => {
    for (const method of ['get', 'post'] as const) {
      const response = await request(app.getHttpServer())
        [method]('/api/v1/nope/at/all')
        .set('X-Requested-With', 'XMLHttpRequest');
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
  });

  it('the set of @Public routes is exactly the allow-list', () => {
    const publicRoutes = routes
      .filter((route) => route.isPublic)
      .map((route) => `${route.method} ${route.path}`);
    expect(publicRoutes.sort()).toEqual([...ALLOWED_PUBLIC_ROUTES].sort());
  });

  it('every non-public route answers 401 UNAUTHENTICATED without a session', async () => {
    const protectedRoutes = routes.filter((route) => !route.isPublic);
    for (const route of protectedRoutes) {
      const path = route.path.replace(/:[A-Za-z]+/g, '00000000-0000-0000-0000-000000000000');
      const response = await request(app.getHttpServer())
        [route.method.toLowerCase() as 'get'](path)
        .set('X-Requested-With', 'XMLHttpRequest');
      expect(response.status, `${route.method} ${route.path}`).toBe(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
    }
  });

  it('every non-GET route refuses a request without the CSRF header (403) before the session check', async () => {
    const mutating = routes.filter((route) => route.method !== 'GET');
    expect(mutating.length).toBeGreaterThan(0);
    for (const route of mutating) {
      const path = route.path.replace(/:[A-Za-z]+/g, '00000000-0000-0000-0000-000000000000');
      const res = await request(app.getHttpServer())[route.method.toLowerCase() as 'post'](path);
      expect(res.status, `${route.method} ${route.path}`).toBe(403);
      expect(res.body.code).toBe('CSRF_REJECTED');
    }
  });

  it('never writes a presented session cookie to the request log', async () => {
    const secret = 'cookie-secret-value-that-must-not-be-logged';
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await request(app.getHttpServer())
        .get('/api/v1/__probe/secure')
        .set('Cookie', `__Host-session=${secret}`);
    } finally {
      spy.mockRestore();
    }
    expect(writes.join('')).not.toContain(secret);
  });

  it('the health route is reachable without a session', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
  });
});

describe('route coverage negative: a nested Express router mounted outside Nest is caught', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // express is a dependency of @nestjs/platform-express, not of this package
    const requireFromNest = createRequire(
      createRequire(import.meta.url).resolve('@nestjs/platform-express'),
    );
    const { Router } = requireFromNest('express') as { Router: () => unknown };
    const sneaky = Router() as {
      get(path: string, handler: (req: unknown, res: { send(body: string): void }) => void): void;
    };
    sneaky.get('/hidden', (_req, res) => res.send('no session needed'));
    const nestedInner = Router() as { use(path: string, router: unknown): void };
    nestedInner.use('/deeper', sneaky);

    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile();
    app = moduleRef.createNestApplication();
    (app.getHttpAdapter().getInstance() as { use(path: string, router: unknown): void }).use(
      '/api/v1/sneaky',
      nestedInner,
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('the unguarded nested route really is reachable without a session', async () => {
    await request(app.getHttpServer()).get('/api/v1/sneaky/deeper/hidden').expect(200);
  });

  it('findUndeclaredRoutes reports it, two router levels deep', () => {
    const expressApp = app.getHttpAdapter().getInstance() as { router: { stack: ExpressLayer[] } };
    const declared = new Set(['GET /__probe/secure', 'POST /__probe/secure']);
    const undeclared = findUndeclaredRoutes(expressApp.router.stack, declared).filter(
      (key) => !FRAMEWORK_ROUTES.includes(key),
    );
    expect(undeclared).toEqual(['GET <nested>/hidden']);
  });

  it('a flat-only walker (the previous implementation) would have missed it', () => {
    const expressApp = app.getHttpAdapter().getInstance() as { router: { stack: ExpressLayer[] } };
    const flat = expressApp.router.stack.filter((layer) => layer.route);
    expect(flat.some((layer) => layer.route?.path === '/hidden')).toBe(false);
  });
});
