# M1b slice 1 — identity core contract (step 1 → Luna)

Local, git-ignored. Source of truth for controllers/DTOs/web. Keep in sync with code.
Import everything identity from `apps/api/src/modules/identity/core` (`index.ts`); guards/decorators/cookie helpers from `apps/api/src/core/auth`; audit from `apps/api/src/core/audit`.

## 0. Wiring (done in `app.module.ts` / `app.wiring.ts`; Luna only adds controllers)

`apps/api/src/app.wiring.ts` is a leaf file exporting `apiConfig`, `database` and `identityCore` (also re-exported by `app.module.ts`):

```ts
export const database = DatabaseModule.forRuntimeRole(apiConfig.DATABASE_URL, 'clinic_app', 'clinik-api');
export const identityCore = IdentityCoreModule.register({ database, trustedProxyCidrs: apiConfig.TRUSTED_PROXY_CIDRS });
// app.module.ts imports: [database, ClockModule, AuditModule.register(database), identityCore, CoreAuthModule.register(identityCore)]
```

**How Luna imports them without a second pool:** in the identity controller module,
`import { identityCore } from '../../app.wiring'` and list it in `imports: [identityCore]`; inject `AuthService`, `SessionService`, `AuthTokenService`, `ClientIpResolver`, ... in the controllers. Import from `app.wiring`, **not** from `app.module` (which imports your module: that would be an import cycle). Never call `DatabaseModule.forRuntimeRole(...)` or `IdentityCoreModule.register(...)` again. `AuditModule.register(database)` is memoised per `database` object, so there is exactly one AuditModule instance. `CoreAuthModule.register(identityCore)` registers the global guards (`APP_GUARD`: CsrfGuard first, then SessionGuard).

Every constructor parameter of every provider/guard must carry an explicit `@Inject(...)`: `pnpm start:dev` runs under tsx, which emits no decorator metadata (test: `test/dev/tsx-di.e2e.spec.ts`; it boots the real AppModule under tsx, so add your controllers' providers there only if they are in AppModule, which they will be).

## 1. Shared types

```ts
interface RequestMeta { ip: string | null; userAgent: string | null; requestId: string }
// build with: requestMetaFrom(req: Request, resolver: ClientIpResolver): RequestMeta
interface SessionRecord { id; userId; ip: string|null; userAgent: string|null; createdAt: Date; lastSeenAt: Date; idleExpiresAt: Date; absoluteExpiresAt: Date }
interface SessionContext { userId: string; sessionId: string; isPlatformAdmin: boolean }
interface AuthUser { id: string; email: string; fullName: string; isPlatformAdmin: boolean; emailVerifiedAt: Date | null }
type PasswordPolicyResult = 'ok' | 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG' | 'PASSWORD_TOO_COMMON' | 'PASSWORD_CONTAINS_EMAIL'
interface Clock { now(): Date }            // token CLOCK; tests override
```

`request.auth` (`AuthenticatedRequest = Request & { auth?: SessionContext }`, exported from `core/auth`) is set by SessionGuard on every non-`@Public` route. Prefer the `@CurrentAuth()` param decorator → `SessionContext`.

## 2. Services (all `@Injectable`, exported by `IdentityCoreModule`)

### PasswordService
```ts
hash(plain: string): Promise<string>                      // argon2id, m=19456 KiB, t=2, p=1
verify(hash: string, plain: string): Promise<boolean>     // never throws
dummyVerify(): Promise<void>                              // same cost, result discarded
checkPolicy(plain: string, ctx: { email: string; fullName: string }): PasswordPolicyResult
```
Policy: length 12..128 (Unicode code points, `[...plain].length`), not in bundled common list (case-insensitive exact match), must not contain the email or its local part (≥4 chars; case-insensitive). `fullName` is accepted for forward compatibility and is currently unused. **Deviation:** `PASSWORD_TOO_LONG` (>128) added to bound argon2 input cost.

### TokenService
```ts
generate(): { raw: string /* base64url, 32 random bytes */; hash: Buffer /* sha256(raw) */ }
hash(raw: string): Buffer
```

### SessionService
```ts
create(userId, meta: {ip, userAgent}, tx?): Promise<{ rawToken: string; session: SessionRecord }>
validate(rawToken: string): Promise<SessionValidation>
// SessionValidation = { status: 'valid'; context: SessionContext } | { status: 'dead' } | { status: 'blocked' }
rotate(sessionId, tx?): Promise<string>                   // new raw token; old row revoked; absolute expiry carried over. Throws SessionNotFoundError
revoke(sessionId, opts?: { userId?: string; reason?: string; meta?: RequestMeta; actorUserId?: string }, tx?): Promise<boolean>
revokeAllForUser(userId, opts?: { exceptSessionId?: string; reason?: string; meta?: RequestMeta; actorUserId?: string }, tx?): Promise<number>
listForUser(userId): Promise<SessionRecord[]>             // active only, most recently seen first
revokeByRawToken(rawToken, opts?: Omit<RevokeOptions,'userId'>, tx?): Promise<{ sessionId: string; userId: string } | null>
```
`tx` (a `TenantTransaction`) lets you compose several calls in one transaction; omit it for a standalone call. The identity tables are not RLS'd, so no tenant context is needed.
- `revoke(..., {userId})` only matches sessions owned by that user (use it for `DELETE /auth/sessions/:id`; `false` ⇒ respond 404).
- When `opts.meta` is given, one `auth.session.revoked` audit row (`resource_type` `session`) is written in the same transaction. `revokeAllForUser` writes one row (`resource_id` NULL, `metadata.{reason,userId,count}`) and **no row when nothing was revoked**. `login_replaced` revocations are attributed to the owner of the revoked session.
- Timeouts (constants in `identity.constants.ts`): staff idle 30 min, absolute 12 h. Sliding refresh of `last_seen_at`/`idle_expires_at` at most once per 60 s; `idle_expires_at` never exceeds `absolute_expires_at`.
- `validate` result: `valid` (attach `context`); `dead` = unknown, revoked, idle-expired or absolute-expired; `blocked` = the session is fine but the user is not `active` (disabled/pending). **Lockout does not affect live sessions (D27):** `locked_until` is ignored by `validate`; it blocks only new logins. The SessionGuard answers 401 `UNAUTHENTICATED` for both `dead` and `blocked`, but clears the cookie **only for `dead`**.
- Patient 60 min idle: deferred to M6.

### LockoutService (used by AuthService; exported for tests)
(D27) Lockout blocks NEW logins only; it never invalidates or rejects an existing session. Threshold 10 consecutive failures ⇒ `locked_until = now + 15 min`. While locked, further attempts are not counted and report the generic failure. When the lock has expired the counter restarts from 0. Success resets counter and lock.

### IpRateLimiter
```ts
consume(bucket: 'login' | 'password-forgot' | 'token-verify', ip: string | null): { allowed: true } | { allowed: false; retryAfterSec: number }
```
Fixed window, in memory, single instance (D12). **Assumed defaults:** login 20 / 60 s / IP; password-forgot 5 / 15 min / IP; token-verify 30 / 60 s / IP. `ip === null` shares the bucket key `"unknown"`. AuthService consumes these buckets itself (login, requestPasswordReset, resetPassword, verifyEmail) — controllers must **not** consume them again.

### ClientIpResolver
```ts
resolve(req: { socket: { remoteAddress?: string }; headers: Record<string, string|string[]|undefined> }): string | null
```
`X-Forwarded-For` is honoured only when the immediate peer is inside `TRUSTED_PROXY_CIDRS`; then the right-most entry that is not itself a trusted proxy is the client. Otherwise the socket address. IPv4-mapped IPv6 is normalised.

### AuthTokenService
```ts
issue(userId, purpose: 'password_reset' | 'email_verify', ttlMs?: number, tx?): Promise<string>   // raw token; earlier unconsumed tokens of that purpose are consumed
peek(raw, purpose): Promise<string | null>                // userId if valid, does not consume
consume(raw, purpose, tx?): Promise<string | null>        // atomic single use → userId
```
TTL defaults (assumptions): password_reset 30 min, email_verify 24 h. Exported as `RESET_TOKEN_TTL_MS`, `VERIFY_TOKEN_TTL_MS`. The expiry comparison uses the injected clock, not SQL `now()` (so fake clocks work); the single-use guarantee is the atomic `UPDATE … WHERE consumed_at IS NULL … RETURNING`.

Issuance takes a transaction-scoped PostgreSQL advisory lock keyed by the user UUID and token purpose before consuming earlier tokens and inserting the new one. Overlapping issuances leave one active token for that user and purpose. The TTL starts after the advisory lock is acquired.

### AuthService (no HTTP)
```ts
login(email, password, meta: RequestMeta, opts?: { currentRawToken?: string }):
  Promise<{ ok: true; rawToken: string; user: AuthUser }
         | { ok: false; code: 'INVALID_CREDENTIALS' }
         | { ok: false; code: 'RATE_LIMITED'; retryAfterSec: number }>
logout(rawToken: string, meta: RequestMeta): Promise<void>
requestPasswordReset(email, meta: RequestMeta): Promise<{ userId: string; rawToken: string } | null>
resetPassword(rawResetToken, newPassword, meta: RequestMeta):
  Promise<{ ok: true; userId: string }
         | { ok: false; code: 'INVALID_TOKEN' | PasswordPolicyError }
         | { ok: false; code: 'RATE_LIMITED'; retryAfterSec: number }>
verifyEmail(rawVerifyToken, meta: RequestMeta):
  Promise<{ ok: true; userId: string }
         | { ok: false; code: 'INVALID_TOKEN' }
         | { ok: false; code: 'RATE_LIMITED'; retryAfterSec: number }>
```
- `login`: unknown email, wrong password, locked, disabled/pending, no password hash ⇒ identical `INVALID_CREDENTIALS` and one argon2 evaluation each (`dummyVerify` when there is no hash to check). On success: presented session (`currentRawToken`) is revoked, a **new** session is created (deviation: login uses revoke+create, not `rotate`, since the old session may belong to another user), lockout counter reset, `last_login_at` set. Rate-limited attempts write no audit row (avoids audit flooding). Map `RATE_LIMITED` → 429 + `Retry-After`.
- Before touching sessions, login locks the user row with `FOR NO KEY UPDATE` and rechecks active status and the verified hash. A hash mismatch uses the wrong-password response and audit path. Password reset takes the user lock before revoking sessions, so a reset that commits first invalidates the old credential and a reset that commits second revokes the session login created.
- `requestPasswordReset`: `null` for unknown/inactive/rate-limited — **always answer 202 generically**; when non-null, send the email (slice 2) containing a link built from `rawToken`. Never log the token/link. (Rate-limited is deliberately indistinguishable from unknown.)
- `resetPassword`: policy is checked *before* the token is consumed (a rejected password does not burn the token). On success: new hash, lockout cleared, **all** sessions of the user revoked (no exception), token consumed. Caller does not log the user in.
- `verifyEmail`: sets `email_verified_at` if it was null.

## 3. Errors → HTTP (all `application/problem+json` via the existing `ProblemDetailsFilter`; the `code` field is the stable machine code)

| Situation | Status | `code` |
|---|---|---|
| No/invalid/expired session cookie | 401 | `UNAUTHENTICATED` |
| Missing `X-Requested-With: XMLHttpRequest` on non-GET/HEAD/OPTIONS | 403 | `CSRF_REJECTED` |
| login bad credentials (all causes) | 401 | `INVALID_CREDENTIALS` |
| login/reset/verify limit | 429 | `RATE_LIMITED` (+ `Retry-After` from the limiter's remaining window) |
| forgot-password, including rate-limited requests | 202 | Generic accepted response |
| bad/used/expired reset/verify token | 400 | `INVALID_TOKEN` |
| password policy | 422 | `PASSWORD_TOO_SHORT` \| `PASSWORD_TOO_LONG` \| `PASSWORD_TOO_COMMON` \| `PASSWORD_CONTAINS_EMAIL` |

Throw with `new HttpException({ code: 'X' }, status)` (the filter only forwards `code` matching `^[A-Z][A-Z0-9_]{1,63}$`). Do not put user input in `detail`.

## 4. Cookie (`core/auth/session-cookie.ts`)
```ts
SESSION_COOKIE_NAME = '__Host-session'
setSessionCookie(res: Response, rawToken: string): void   // HttpOnly; Secure; SameSite=Lax; Path=/; no Domain; Max-Age=43200
clearSessionCookie(res: Response): void
readSessionCookie(req: Request): string | undefined
```
Set it on login success; clear it on logout and on 401 (SessionGuard clears automatically when a stale cookie was sent).

## 5. Guards & decorators (`core/auth`)
- `CsrfGuard` (global, runs first): non-GET/HEAD/OPTIONS need header `X-Requested-With: XMLHttpRequest`, else 403 `CSRF_REJECTED`. Applies to `@Public` routes too. `@SkipCsrf()` exists **only** for the signature-verified Stripe webhook (M5); do not use it elsewhere.
- `SessionGuard` (global): cookie → `SessionService.validate` → `request.auth` (only for `valid`). 401 `UNAUTHENTICATED` otherwise; the cookie is cleared only when the session is `dead`, never for `blocked` (D27). Skipped by `@Public()`.
- `@Public()` — class or method. Currently only `GET /api/v1/health` and (your) `POST /auth/login`, `POST /auth/password/forgot`, `POST /auth/password/reset`, `POST /auth/email/verify`, invitation preview/accept. The route-coverage test (`test/http/route-coverage.e2e.spec.ts`) holds an allow-list of public routes: **adding a public route means editing that list on purpose.**
- `@CurrentAuth()` → `SessionContext`.

## 6. Audit (`core/audit`)
```ts
AuditWriter.record(event: {
  action: string; outcome: 'success' | 'denied' | 'error';
  actorUserId?: string | null; organizationId?: string | null;
  resourceType: string; resourceId?: string | null;
  requestId?: string | null; ip?: string | null; userAgent?: string | null;
  metadata?: Record<string, unknown>; changedFields?: string[]; actorType?: 'user'|'system'|'webhook';
}, tx?: Tx): Promise<void>
```
With `tx` the row is written in that transaction; without, in its own short transaction (with tenant context if `organizationId` is set). Metadata keys matching password/token/cookie/secret/hash/link/authorization/set-cookie are replaced by `[REDACTED]`. `organization_id` is NULL for auth events.

Constants: `AuthAuditAction` (identity.constants.ts). Actions: `auth.login.success`, `auth.login.failure` (metadata.reason ∈ unknown_email|bad_password|locked|inactive), `auth.lockout`, `auth.logout`, `auth.session.revoked`, `auth.password_reset.requested`, `auth.password_reset.completed`, `auth.email.verified`. Resource types: `session` (login/logout/revoked), `user` (lockout, reset, verify). Controllers do not write these; the services do.

## 7. Config and client IP (D28)
| Key | Where | Default |
|---|---|---|
| `TRUSTED_PROXY_CIDRS` | API env; comma-separated CIDRs/IPs | empty = trust nobody (right for `pnpm start:dev`). **Compose sets it to exactly `<WEB_IP>/32`** (web's static address `172.28.0.10` on subnet `172.28.0.0/24`; override with `WEB_IP` / `COMPOSE_SUBNET` in `.env`) |

All other values are constants in `identity.constants.ts`.

How the client IP is made trustworthy: the browser only ever talks to **web**, a custom Next server (`apps/web/server.ts`, compiled to `dist-server/server.js`; scripts `dev`/`build`/`start` updated) that, before Next's `/api` rewrite proxies the request, discards any client-supplied `X-Forwarded-For`, `Forwarded` and `X-Real-IP` and sets `X-Forwarded-For` to the TCP peer address. The **API port is not published** to the host (`expose` only); the only peer allowed to speak for a client is the web container. In the API, `ClientIpResolver` honours `X-Forwarded-For` only when the socket peer is inside `TRUSTED_PROXY_CIDRS`; otherwise it uses the socket address. Locally (Docker Desktop) the "client" seen is the Docker gateway (`172.28.0.1`), so all local browser traffic shares one rate-limit bucket; that is expected and not a production concern.

Do not add any other path to the API (published port, second proxy) without adding that proxy to `TRUSTED_PROXY_CIDRS` deliberately.

## 7a. Accepted residuals
- **Staff invitation account existence (D26):** A token holder can distinguish a new-user validation error (`422`) from the `401` an existing account returns without a matching session. The preview already shows the invited email, so this distinction is accepted.
- **Reset-request timing:** `requestPasswordReset` for a known active email does two small DB writes (token + audit) that an unknown email does not (an audit write only). Measured difference about 3 ms, accepted: it is far below network jitter and email sending (slice 2) must be asynchronous so it adds no further signal.
- **Rate-limited logins write no audit row** (deliberate): a flood from one IP would otherwise flood `audit_logs`. The 429 itself is logged by pino-http (method/status/request id only).
- Fixed-window limiter allows up to 2x the limit across a window boundary; in-memory per process (D12).

## 8. Example controller usage
```ts
@Public() @Post('auth/login') @HttpCode(200)
async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
  const meta = requestMetaFrom(req, this.ipResolver);
  const r = await this.auth.login(dto.email, dto.password, meta, { currentRawToken: readSessionCookie(req) });
  if (!r.ok) {
    if (r.code === 'RATE_LIMITED') { res.setHeader('Retry-After', String(r.retryAfterSec)); throw new HttpException({ code: 'RATE_LIMITED' }, 429); }
    throw new HttpException({ code: 'INVALID_CREDENTIALS' }, 401);
  }
  setSessionCookie(res, r.rawToken);
  return { user: r.user };
}
```
