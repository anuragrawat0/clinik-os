import { Controller, Get, Module, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { Res } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CoreAuthModule } from '../../src/core/auth/auth.module';
import { CurrentAuth } from '../../src/core/auth/auth-context';
import { Public } from '../../src/core/auth/public.decorator';
import { setSessionCookie, clearSessionCookie } from '../../src/core/auth/session-cookie';
import { SkipCsrf } from '../../src/core/auth/skip-csrf.decorator';
import { ProblemDetailsFilter } from '../../src/core/errors/problem-details.filter';
import {
  SessionService,
  type SessionValidation,
} from '../../src/modules/identity/core/session.service';
import type { SessionContext } from '../../src/modules/identity/core/types';

const GOOD_TOKEN = 'good-token-value';
const BLOCKED_TOKEN = 'blocked-user-token';
const csrf = { 'X-Requested-With': 'XMLHttpRequest' };
const session: SessionContext = { userId: 'u1', sessionId: 's1', isPlatformAdmin: false };

@Controller('t')
class DummyController {
  @Public() @Get('open') open(): { open: true } {
    return { open: true };
  }
  @Public() @Post('login') login(@Res({ passthrough: true }) res: Response): { ok: true } {
    setSessionCookie(res, 'issued-token');
    return { ok: true };
  }
  @Public() @Post('logout-cookie') clear(@Res({ passthrough: true }) res: Response): { ok: true } {
    clearSessionCookie(res);
    return { ok: true };
  }
  @Get('secure') secureGet(@CurrentAuth() auth: SessionContext): SessionContext {
    return auth;
  }
  @Post('secure') securePost(@CurrentAuth() auth: SessionContext): SessionContext {
    return auth;
  }
  @Public() @SkipCsrf() @Post('webhook') webhook(): { hook: true } {
    return { hook: true };
  }
}

const validate = vi.fn<(raw: string) => Promise<SessionValidation>>(async (raw) => {
  if (raw === GOOD_TOKEN) return { status: 'valid', context: session };
  if (raw === BLOCKED_TOKEN) return { status: 'blocked' };
  return { status: 'dead' };
});

@Module({
  providers: [{ provide: SessionService, useValue: { validate } }],
  exports: [SessionService],
})
class StubIdentityModule {}

@Module({
  imports: [CoreAuthModule.register({ module: StubIdentityModule })],
  controllers: [DummyController],
})
class GuardTestModule {}

describe('global guards (test-only module with dummy routes)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [GuardTestModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('CsrfGuard', () => {
    it('rejects a state-changing request without X-Requested-With with 403 CSRF_REJECTED', async () => {
      const response = await request(app.getHttpServer())
        .post('/t/secure')
        .set('Cookie', `__Host-session=${GOOD_TOKEN}`)
        .expect(403);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body).toMatchObject({ status: 403, code: 'CSRF_REJECTED' });
    });

    it('rejects a wrong header value', async () => {
      await request(app.getHttpServer())
        .post('/t/secure')
        .set('Cookie', `__Host-session=${GOOD_TOKEN}`)
        .set('X-Requested-With', 'fetch')
        .expect(403);
    });

    it('still requires the header on @Public POST routes', async () => {
      await request(app.getHttpServer()).post('/t/login').expect(403);
      await request(app.getHttpServer()).post('/t/login').set(csrf).expect(201);
    });

    it('allows GET without the header', async () => {
      await request(app.getHttpServer()).get('/t/open').expect(200);
    });

    it('accepts the header on an authenticated POST', async () => {
      const response = await request(app.getHttpServer())
        .post('/t/secure')
        .set(csrf)
        .set('Cookie', `__Host-session=${GOOD_TOKEN}`)
        .expect(201);
      expect(response.body).toEqual(session);
    });

    it('@SkipCsrf exempts only the marked route', async () => {
      await request(app.getHttpServer()).post('/t/webhook').expect(201);
      await request(app.getHttpServer()).post('/t/login').expect(403);
    });
  });

  describe('SessionGuard', () => {
    it('401 problem+json UNAUTHENTICATED without a cookie', async () => {
      const response = await request(app.getHttpServer()).get('/t/secure').expect(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.body).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    });

    it('401 for an invalid session and clears the stale cookie', async () => {
      const response = await request(app.getHttpServer())
        .get('/t/secure')
        .set('Cookie', '__Host-session=stale-token')
        .expect(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
      const cleared = String(response.headers['set-cookie']);
      expect(cleared).toContain('__Host-session=;');
      expect(cleared).toContain('Expires=Thu, 01 Jan 1970');
    });

    it('rejects a blocked user with 401 but leaves the cookie alone (D27)', async () => {
      const response = await request(app.getHttpServer())
        .get('/t/secure')
        .set('Cookie', `__Host-session=${BLOCKED_TOKEN}`)
        .expect(401);
      expect(response.body.code).toBe('UNAUTHENTICATED');
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('ignores other cookies and a cookie with the wrong name', async () => {
      await request(app.getHttpServer())
        .get('/t/secure')
        .set('Cookie', `session=${GOOD_TOKEN}; other=1`)
        .expect(401);
    });

    it('attaches request.auth for a valid session', async () => {
      const response = await request(app.getHttpServer())
        .get('/t/secure')
        .set('Cookie', `foo=bar; __Host-session=${GOOD_TOKEN}`)
        .expect(200);
      expect(response.body).toEqual(session);
    });

    it('@Public bypasses the session check (even with an invalid cookie)', async () => {
      validate.mockClear();
      await request(app.getHttpServer())
        .get('/t/open')
        .set('Cookie', '__Host-session=stale-token')
        .expect(200);
      expect(validate).not.toHaveBeenCalled();
    });
  });

  describe('session cookie helper', () => {
    it('sets HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=12h and no Domain', async () => {
      const response = await request(app.getHttpServer()).post('/t/login').set(csrf);
      const header = String(response.headers['set-cookie']);
      expect(header).toContain('__Host-session=issued-token');
      expect(header).toContain('Max-Age=43200');
      expect(header).toContain('Path=/');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('Secure');
      expect(header).toContain('SameSite=Lax');
      expect(header).not.toMatch(/Domain=/i);
    });

    it('clears with the same attributes', async () => {
      const response = await request(app.getHttpServer()).post('/t/logout-cookie').set(csrf);
      const header = String(response.headers['set-cookie']);
      expect(header).toContain('__Host-session=;');
      expect(header).toContain('Path=/');
      expect(header).toContain('HttpOnly');
      expect(header).toContain('Secure');
      expect(header).toContain('SameSite=Lax');
      expect(header).not.toMatch(/Domain=/i);
    });
  });
});
