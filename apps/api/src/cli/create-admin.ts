import 'reflect-metadata';
import type { Readable } from 'node:stream';
import { parseArgs } from 'node:util';
import { displayName } from '@clinik/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AuditWriter } from '../core/audit/audit-writer';
import { DatabaseConnection } from '../core/db/database.module';
import { users } from '../core/db/schema/m1a';
import { PasswordService } from '../modules/identity/core';

const identityInput = z.object({
  email: z.email().max(254),
  name: displayName.refine((name) => name.length <= 200),
});

type PasswordInput = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(enabled: boolean): unknown;
};

export async function readPassword(
  input: PasswordInput,
  prompt: (message: string) => void,
): Promise<string | undefined> {
  const terminal = input.isTTY === true;
  const wasRaw = input.isRaw ?? false;
  const line: string[] = [];
  let password: string | undefined;
  let skipLineFeed = false;
  input.setEncoding('utf8');
  if (terminal) input.setRawMode?.(true);
  try {
    if (terminal) prompt('Password: ');
    for await (const chunk of input.iterator({ destroyOnReturn: false })) {
      for (const character of chunk as string) {
        const trailingLineFeed = skipLineFeed && character === '\n';
        skipLineFeed = character === '\r';
        if (trailingLineFeed) continue;
        if (character === '\r' || character === '\n') {
          const value = line.join('');
          if (!terminal) return value;
          if (password !== undefined) {
            prompt('\n');
            return value === password ? password : undefined;
          }
          password = value;
          line.length = 0;
          prompt('\nConfirm password: ');
        } else if (terminal && (character === '\b' || character === '\x7f')) {
          line.pop();
        } else if (terminal && (character === '\x03' || character === '\x04')) {
          prompt('\n');
          return undefined;
        } else {
          line.push(character);
        }
      }
    }
    return !terminal && line.length > 0 ? line.join('') : undefined;
  } finally {
    input.pause();
    if (terminal) input.setRawMode?.(wasRaw);
  }
}

function fail(code: number, message: string): number {
  process.stderr.write(`${message}\n`);
  return code;
}

async function createAdmin(): Promise<number> {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } }));
  } catch {
    return fail(1, 'USAGE: admin:create --email <email> --name "<full name>"');
  }
  const identity = identityInput.safeParse(values);
  if (!identity.success) return fail(1, 'INVALID_EMAIL_OR_NAME');
  const { email, name: fullName } = identity.data;

  const url = process.env.DATABASE_URL?.trim();
  if (!url) return fail(2, 'DATABASE_URL_MISSING');
  const databaseUrl = z.url({ protocol: /^postgres(ql)?$/ }).safeParse(url);
  if (!databaseUrl.success) return fail(3, 'DB_CONNECT_FAILED');

  const password = await readPassword(process.stdin, (message) => process.stderr.write(message));
  if (password === undefined) return fail(2, 'PASSWORD_MISSING_OR_CONFIRMATION_MISMATCH');
  const passwords = new PasswordService();
  const policy = passwords.checkPolicy(password, { email, fullName });
  if (policy !== 'ok') return fail(2, policy);

  const passwordHash = await passwords.hash(password);
  const connection = new DatabaseConnection(databaseUrl.data, 'clinic_app', 'clinik-admin-create');
  // pg discards failed idle clients. Keep its error event from printing a raw diagnostic.
  connection.pool.on('error', () => {});
  let id: string | undefined;
  try {
    try {
      // Separate connection failures from the runtime role check and the creation transaction.
      const client = await connection.pool.connect();
      client.release();
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code === '28P01' || code === '28000') return fail(3, 'DB_AUTH_FAILED');
      if (code === '3D000') return fail(3, 'DB_NOT_FOUND');
      return fail(3, 'DB_CONNECT_FAILED');
    }
    await connection.onModuleInit();
    id = await connection.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          email,
          fullName,
          passwordHash,
          status: 'active',
          isPlatformAdmin: true,
          emailVerifiedAt: sql`now()`,
        })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      if (!user) return undefined;
      await new AuditWriter(connection).record(
        {
          action: 'platform_admin.created',
          actorType: 'system',
          organizationId: null,
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'success',
        },
        tx,
      );
      return user.id;
    });
  } finally {
    await connection.onModuleDestroy().catch(() => {});
  }
  if (id === undefined) return fail(1, 'EMAIL_EXISTS');
  process.stdout.write(`${id}\n`);
  return 0;
}

if (require.main === module) {
  void createAdmin()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      process.exitCode = fail(4, 'ADMIN_CREATE_FAILED');
    });
}
