import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBody,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  CurrentAuth,
  Public,
  clearSessionCookie,
  readSessionCookie,
  setSessionCookie,
} from '../../core/auth';
import { parseInput } from '../../core/errors/http-validation';
import { AuthMailer } from '../notifications/auth-mailer';
import {
  ForgotPasswordDto,
  ForgotResponseDto,
  LoginDto,
  LoginResponseDto,
  MeResponseDto,
  ResetPasswordDto,
  SessionDto,
  VerifyEmailDto,
  forgotInput,
  loginInput,
  resetInput,
  verifyInput,
} from './auth.dto';
import { AuthProfileService } from './auth-profile.service';
import {
  AuthService,
  ClientIpResolver,
  SessionService,
  requestMetaFrom,
  type ResetPasswordResult,
  type SessionContext,
} from './core';

const sessionId = z.guid();

function rateLimited(res: Response, retryAfter: number): never {
  res.setHeader('Retry-After', String(retryAfter));
  throw new HttpException({ code: 'RATE_LIMITED' }, HttpStatus.TOO_MANY_REQUESTS);
}

function checkTokenResult(result: ResetPasswordResult, res: Response): void {
  if (result.ok) return;
  if (result.code === 'RATE_LIMITED') rateLimited(res, result.retryAfterSec);
  throw new HttpException(
    { code: result.code },
    result.code === 'INVALID_TOKEN' ? HttpStatus.BAD_REQUEST : HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ClientIpResolver) private readonly ipResolver: ClientIpResolver,
    @Inject(AuthProfileService) private readonly profile: AuthProfileService,
    @Inject(AuthMailer) private readonly mailer: AuthMailer,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiBody({ type: LoginDto })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @ApiResponse({
    status: 429,
    description: 'Rate limited',
    headers: { 'Retry-After': { schema: { type: 'integer' } } },
  })
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    const { email, password } = parseInput(loginInput, body);
    const currentRawToken = readSessionCookie(req);
    const result = await this.auth.login(
      email,
      password,
      requestMetaFrom(req, this.ipResolver),
      currentRawToken ? { currentRawToken } : undefined,
    );
    if (!result.ok) {
      if (result.code === 'RATE_LIMITED') rateLimited(res, result.retryAfterSec);
      throw new HttpException({ code: result.code }, HttpStatus.UNAUTHORIZED);
    }
    setSessionCookie(res, result.rawToken);
    return { user: result.user };
  }

  @Post('logout')
  @HttpCode(204)
  @ApiCookieAuth()
  @ApiNoContentResponse()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const rawToken = readSessionCookie(req);
    if (rawToken) await this.auth.logout(rawToken, requestMetaFrom(req, this.ipResolver));
    clearSessionCookie(res);
  }

  @Get('me')
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth()
  @ApiOkResponse({ type: MeResponseDto })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  me(@CurrentAuth() session: SessionContext): Promise<MeResponseDto> {
    return this.profile.get(session.userId);
  }

  @Get('sessions')
  @Header('Cache-Control', 'no-store')
  @ApiCookieAuth()
  @ApiOkResponse({ type: SessionDto, isArray: true })
  async listSessions(@CurrentAuth() auth: SessionContext): Promise<SessionDto[]> {
    const sessions = await this.sessions.listForUser(auth.userId);
    return sessions.map((session) => ({
      id: session.id,
      ip: session.ip,
      userAgent: session.userAgent,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      current: session.id === auth.sessionId,
    }));
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  @ApiCookieAuth()
  @ApiParam({ name: 'id', schema: { type: 'string', format: 'uuid' } })
  @ApiNoContentResponse()
  @ApiResponse({ status: 404, description: 'Session unavailable' })
  async revokeSession(
    @Param('id') id: string,
    @CurrentAuth() auth: SessionContext,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const parsed = sessionId.safeParse(id);
    const revoked =
      parsed.success &&
      (await this.sessions.revoke(parsed.data, {
        userId: auth.userId,
        actorUserId: auth.userId,
        reason: 'user_revoked',
        meta: requestMetaFrom(req, this.ipResolver),
      }));
    if (!revoked) throw new HttpException({ code: 'NOT_FOUND' }, HttpStatus.NOT_FOUND);
    if (parsed.data === auth.sessionId) clearSessionCookie(res);
  }

  @Public()
  @Post('password/forgot')
  @HttpCode(202)
  @ApiBody({ type: ForgotPasswordDto })
  @ApiAcceptedResponse({ type: ForgotResponseDto })
  async forgotPassword(@Body() body: unknown, @Req() req: Request): Promise<ForgotResponseDto> {
    const input = forgotInput.safeParse(body);
    const email = input.success ? input.data.email : '';
    const result = await this.auth.requestPasswordReset(
      email,
      requestMetaFrom(req, this.ipResolver),
    );
    if (result) {
      setImmediate(() => {
        void this.mailer.send('password_reset', result.rawToken, () =>
          this.profile.getActiveEmail(result.userId),
        );
      });
    }
    return { accepted: true };
  }

  @Public()
  @Post('password/reset')
  @HttpCode(204)
  @ApiBody({ type: ResetPasswordDto })
  @ApiNoContentResponse()
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  @ApiResponse({ status: 422, description: 'Password policy rejected the password' })
  @ApiResponse({ status: 429, description: 'Rate limited' })
  async resetPassword(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const { token, password } = parseInput(resetInput, body);
    checkTokenResult(
      await this.auth.resetPassword(token, password, requestMetaFrom(req, this.ipResolver)),
      res,
    );
  }

  @Public()
  @Post('email/verify')
  @HttpCode(204)
  @ApiBody({ type: VerifyEmailDto })
  @ApiNoContentResponse()
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  @ApiResponse({ status: 429, description: 'Rate limited' })
  async verifyEmail(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const { token } = parseInput(verifyInput, body);
    checkTokenResult(
      await this.auth.verifyEmail(token, requestMetaFrom(req, this.ipResolver)),
      res,
    );
  }
}
