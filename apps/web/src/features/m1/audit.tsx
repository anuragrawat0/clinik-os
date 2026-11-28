'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client/client';
import { responseData } from '@/lib/api-client/problems';
import type { components } from '@/lib/api-client/schema';
import { clinicKey, clinicParams, useMembers } from './clinic-data';
import { hasPermission } from './permissions';
import { useClinic } from './shell';
import { Heading, LoadError, LoadMore, Notice, Unavailable, textField } from './ui';

type Filters = { actorId?: string; action?: string; from?: string; to?: string };
const asInstant = (value: string) => (value ? new Date(value).toISOString() : undefined);
export const auditTimestampOptions: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
  timeZoneName: 'short',
};
const eventTime = new Intl.DateTimeFormat(undefined, auditTimestampOptions);

function actorDisplay({ actorType, actorLabel, actorName }: components['schemas']['AuditLogDto']) {
  if (actorType === 'system') return 'System';
  if (actorType === 'webhook') return 'Webhook';
  switch (actorLabel) {
    case 'platform_admin':
      return 'Platform administrator';
    case 'member':
      return actorName ?? 'Clinic member';
    case 'former_member':
      return `${actorName ?? 'Clinic member'} (removed)`;
    default:
      return 'Unknown actor';
  }
}

export function AuditLog() {
  const { roles } = useClinic();
  return hasPermission(roles, 'audit.read') ? <Events /> : <Unavailable />;
}

function Events() {
  const orgId = useClinic().membership.organizationId;
  const [filters, setFilters] = useState<Filters>({});
  const members = useMembers(orgId);
  const audit = useInfiniteQuery({
    queryKey: [...clinicKey(orgId), 'audit', filters],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      responseData(
        await apiClient.GET('/api/v1/orgs/{orgId}/audit-logs', {
          params: { ...clinicParams(orgId), query: { ...filters, cursor: pageParam } },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = audit.data?.pages.flatMap(({ items }) => items) ?? [];
  return (
    <>
      <Heading title="Audit log" />
      <form
        className="m1-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setFilters({
            actorId: textField(data, 'actor') || undefined,
            action: textField(data, 'action') || undefined,
            from: asInstant(textField(data, 'from')),
            to: asInstant(textField(data, 'to')),
          });
        }}
        onReset={() => setFilters({})}
      >
        <label className="m1-field">
          Actor ID
          <input
            name="actor"
            list="audit-actors"
            pattern="[0-9a-fA-F]{8}\x2D[0-9a-fA-F]{4}\x2D[0-9a-fA-F]{4}\x2D[0-9a-fA-F]{4}\x2D[0-9a-fA-F]{12}"
          />
        </label>
        <datalist id="audit-actors">
          {members.data?.map(({ userId, fullName }) => (
            <option key={userId} value={userId} label={fullName} />
          ))}
        </datalist>
        <label className="m1-field">
          Action
          <input name="action" maxLength={128} />
        </label>
        <label className="m1-field">
          From
          <input type="datetime-local" name="from" />
        </label>
        <label className="m1-field">
          To
          <input type="datetime-local" name="to" />
        </label>
        <Button type="submit">Apply filters</Button>
        <Button type="reset" tone="quiet">
          Clear
        </Button>
      </form>
      {audit.isPending && <Notice>Loading audit events…</Notice>}
      {audit.isError && !audit.data && <LoadError error={audit.error} />}
      {audit.isSuccess && !items.length && (
        <p className="m1-empty">No audit events match these filters.</p>
      )}
      {items.length > 0 && (
        <div className="m1-table-region">
          <table className="m1-table" aria-label="Audit events">
            <thead>
              <tr>
                {['Time', 'Action', 'Actor', 'Resource', 'Outcome', 'Changed fields'].map(
                  (name) => (
                    <th key={name} scope="col">
                      {name}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <time dateTime={item.occurredAt}>
                      {eventTime.format(new Date(item.occurredAt))}
                    </time>
                  </td>
                  <td>{item.action}</td>
                  <td>{actorDisplay(item)}</td>
                  <td>
                    {item.resourceType}
                    {item.resourceId && <div className="m1-muted">{item.resourceId}</div>}
                  </td>
                  <td>{item.outcome}</td>
                  <td>{item.changedFields?.join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {audit.hasNextPage && (
        <LoadMore
          load={() => void audit.fetchNextPage()}
          busy={audit.isFetchingNextPage}
          error={audit.isFetchNextPageError ? audit.error : null}
        />
      )}
    </>
  );
}
