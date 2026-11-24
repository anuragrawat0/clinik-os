import { HttpException, applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { sql, type SQLWrapper } from 'drizzle-orm';
import { z } from 'zod';

export const pageLimit = z
  .string()
  .regex(/^\d{1,3}$/)
  .transform(Number)
  .pipe(z.number().int().min(1).max(100))
  .default(50);

export function CursorPageQueries() {
  return applyDecorators(
    ApiQuery({ name: 'cursor', type: String, required: false, description: 'Opaque page cursor' }),
    ApiQuery({
      name: 'limit',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    }),
  );
}

const timestamp = z.iso
  .datetime()
  .refine((value) => !value.startsWith('0000-') && /T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value));

function invalidCursor(): never {
  throw new HttpException({ code: 'INVALID_CURSOR' }, 400);
}

/** A cursor supplies only a position. Callers independently apply authorization and filters. */
export function readCursor(value: unknown, idSchema: z.ZodType<string>) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 256 || !/^[\w-]+$/.test(value)) invalidCursor();
  const payload = Buffer.from(value, 'base64url');
  if (payload.toString('base64url') !== value) invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload.toString('utf8'));
  } catch {
    invalidCursor();
  }
  const position = z.tuple([timestamp, idSchema]).safeParse(decoded);
  if (!position.success) invalidCursor();
  const [at, id] = position.data;
  return { at, id };
}

/** JavaScript Dates round away PostgreSQL's sub-millisecond ordering. */
export function cursorTimestamp(column: SQLWrapper) {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

export function cursorPage<T extends { cursorAt: string; id: string | bigint }>(
  rows: T[],
  limit: number,
) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  if (rows.length <= limit || !last) return { items, nextCursor: null };
  const nextCursor = Buffer.from(JSON.stringify([last.cursorAt, String(last.id)])).toString(
    'base64url',
  );
  return { items, nextCursor };
}
