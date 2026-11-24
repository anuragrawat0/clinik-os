import { ApiProperty } from '@nestjs/swagger';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { notFound } from '../access/access';
import { auditLogs, organizationMembers } from '../db/schema/m1a';
import { cursorPage, cursorTimestamp, pageLimit, readCursor } from '../pagination/cursor';
import type { TenantOperation } from '../tenancy-context/request-transaction';

const uuid = z
  .guid()
  .transform((id) => id.toLowerCase())
  .optional();
const instant = z.iso.datetime({ offset: true }).optional();
const auditCursorId = z
  .string()
  .refine((value) => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n);
export const auditListQuery = z.strictObject({
  actorId: uuid,
  // M3 will validate against the patient registry. In M1 only org audit history is available.
  patientId: uuid,
  action: z
    .string()
    .max(128)
    .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
    .optional(),
  from: instant,
  to: instant,
  cursor: z.unknown().optional(),
  limit: pageLimit,
});

const nullableUuid = { type: String, format: 'uuid', nullable: true };

class AuditLogDto {
  @ApiProperty({ type: String, description: 'Audit ID as a decimal string' }) id!: string;
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: string;
  @ApiProperty(nullableUuid) actorUserId!: string | null;
  @ApiProperty({ enum: ['user', 'system', 'webhook'] }) actorType!: string;
  @ApiProperty({ type: String }) action!: string;
  @ApiProperty({ type: String }) resourceType!: string;
  @ApiProperty({ type: String, nullable: true }) resourceId!: string | null;
  @ApiProperty({ enum: ['success', 'denied', 'error'] }) outcome!: string;
  @ApiProperty({ type: [String], nullable: true }) changedFields!: string[] | null;
  @ApiProperty(nullableUuid) branchId!: string | null;
}

export class AuditLogPageDto {
  @ApiProperty({ type: [AuditLogDto] }) items!: AuditLogDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export async function listAuditLogs(
  { orgId, tx }: TenantOperation,
  { actorId, patientId, action, from, to, cursor, limit }: z.output<typeof auditListQuery>,
): Promise<AuditLogPageDto> {
  const since = readCursor(cursor, auditCursorId);
  const inOrg = eq(auditLogs.organizationId, orgId);
  const actor = actorId ? eq(auditLogs.actorUserId, actorId) : undefined;
  const patient = patientId ? eq(auditLogs.patientId, patientId) : undefined;

  if (actorId) {
    // A platform actor can appear in the organization's history without being a member.
    const member = tx
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(eq(organizationMembers.organizationId, orgId));
    const {
      rows: [found],
    } = await tx.execute<{ visible: boolean }>(
      sql`SELECT ${actorId}::uuid IN (${member}) OR EXISTS (${tx
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(and(inOrg, actor))}) AS visible`,
    );
    if (!found.visible) notFound();
  }
  if (patient) {
    const [found] = await tx
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(inOrg, patient))
      .limit(1);
    if (!found) notFound();
  }

  const rows = await tx
    .select({
      id: auditLogs.id,
      cursorAt: cursorTimestamp(auditLogs.occurredAt),
      actorUserId: auditLogs.actorUserId,
      actorType: auditLogs.actorType,
      action: auditLogs.action,
      resourceType: auditLogs.resourceType,
      resourceId: auditLogs.resourceId,
      outcome: auditLogs.outcome,
      changedFields: auditLogs.changedFields,
      branchId: auditLogs.branchId,
    })
    .from(auditLogs)
    .where(
      and(
        inOrg,
        actor,
        patient,
        action ? eq(auditLogs.action, action) : undefined,
        from ? sql`${auditLogs.occurredAt} >= ${from}::timestamptz` : undefined,
        to ? sql`${auditLogs.occurredAt} <= ${to}::timestamptz` : undefined,
        since
          ? sql`(${auditLogs.occurredAt}, ${auditLogs.id}) < (${since.at}::timestamptz, ${since.id}::bigint)`
          : undefined,
      ),
    )
    .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
    .limit(limit + 1);
  const page = cursorPage(rows, limit);
  return {
    nextCursor: page.nextCursor,
    items: page.items.map(({ id, cursorAt, ...item }) => ({
      ...item,
      id: String(id),
      occurredAt: cursorAt,
    })),
  };
}
