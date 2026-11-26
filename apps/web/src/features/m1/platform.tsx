'use client';

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client/client';
import { responseData } from '@/lib/api-client/problems';
import type { components } from '@/lib/api-client/schema';
import {
  Confirm,
  FormDialog,
  Heading,
  LoadError,
  LoadMore,
  Notice,
  Timezone,
  textField,
} from './ui';

const organizationsKey = ['platform', 'organizations'] as const;
const adminPath = '/admin/organizations';
type Provisioned = components['schemas']['ProvisionedOrganizationDto'];

function OwnerFields({ optional = false }: { optional?: boolean }) {
  const [email, setEmail] = useState('');
  return (
    <>
      <label className="m1-field">
        Owner email{optional ? ' (optional)' : ''}
        <input
          type="email"
          name="ownerEmail"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          maxLength={254}
          required={!optional}
        />
      </label>
      <label className="m1-field">
        Owner full name (optional)
        <input name="ownerName" maxLength={200} disabled={!email.trim()} />
      </label>
    </>
  );
}

export function PlatformOrganizations() {
  const cache = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Provisioned>();
  const list = useInfiniteQuery({
    queryKey: organizationsKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      responseData(
        await apiClient.GET('/api/v1/admin/organizations', {
          params: { query: { cursor: pageParam } },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const organizations = list.data?.pages.flatMap(({ items }) => items) ?? [];

  return (
    <>
      <Heading
        title="Organizations"
        actions={
          <Button type="button" onClick={() => setCreating(true)}>
            Create organization
          </Button>
        }
      />
      {created && (
        <Notice alert={created.ownerInvitation?.emailDelivery === 'failed'}>
          <Link className="m1-back" href={`${adminPath}/${created.id}`}>
            {created.name}
          </Link>{' '}
          was created.
          {created.ownerInvitation?.emailDelivery === 'failed' &&
            ' The owner invitation email could not be delivered. Open the organization to resend it.'}
        </Notice>
      )}
      {list.isPending && <Notice>Loading organizations…</Notice>}
      {list.isError && !list.data && <LoadError error={list.error} />}
      {list.isSuccess && organizations.length === 0 && (
        <p className="m1-empty">No organizations have been created.</p>
      )}
      {organizations.length > 0 && (
        <div className="m1-table-region">
          <table className="m1-table" aria-label="Organizations">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {organizations.map((org) => (
                <tr key={org.id}>
                  <td>
                    <Link href={`${adminPath}/${org.id}`}>{org.name}</Link>
                  </td>
                  <td>{org.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasNextPage && (
        <LoadMore
          load={() => void list.fetchNextPage()}
          busy={list.isFetchingNextPage}
          error={list.isFetchNextPageError ? list.error : null}
        />
      )}
      {creating && (
        <FormDialog
          title="Create organization"
          submit="Create organization"
          onClose={() => setCreating(false)}
          action={async (values) => {
            const ownerEmail = textField(values, 'ownerEmail');
            const ownerFullName = textField(values, 'ownerName');
            const result = responseData(
              await apiClient.POST('/api/v1/admin/organizations', {
                body: {
                  name: textField(values, 'name'),
                  slug: textField(values, 'slug'),
                  defaultTimezone: textField(values, 'timezone'),
                  ownerEmail: ownerEmail || undefined,
                  ownerFullName: ownerEmail && ownerFullName ? ownerFullName : undefined,
                },
              }),
            );
            setCreated(result);
            await cache.invalidateQueries({ queryKey: organizationsKey });
          }}
        >
          <label className="m1-field">
            Name
            <input name="name" required maxLength={200} />
          </label>
          <label className="m1-field">
            Slug
            <input
              name="slug"
              required
              pattern="[a-z0-9][a-z0-9\x2D]{2,62}"
              title="Use 3 to 63 lowercase letters, numbers or hyphens."
            />
          </label>
          <Timezone />
          <OwnerFields optional />
        </FormDialog>
      )}
    </>
  );
}

export function PlatformOrganization({ id }: { id: string }) {
  const cache = useQueryClient();
  const [dialog, setDialog] = useState<'edit' | 'status' | 'invite'>();
  const [delivery, setDelivery] = useState<'sent' | 'failed'>();
  const params = { path: { id } };
  const orgKey = [...organizationsKey, id] as const;
  const query = useQuery({
    queryKey: orgKey,
    queryFn: async ({ signal }) =>
      responseData(await apiClient.GET('/api/v1/admin/organizations/{id}', { params, signal })),
  });
  const close = () => setDialog(undefined);
  if (query.isPending) return <Notice>Loading organization…</Notice>;
  if (query.isError) return <LoadError error={query.error} />;
  const org = query.data;
  const suspended = org.status === 'suspended';
  const statusLabel = suspended ? 'Reactivate organization' : 'Suspend organization';

  return (
    <>
      <Link className="m1-back" href={adminPath}>
        All organizations
      </Link>
      <Heading title={org.name} />
      <section className="m1-panel" aria-label="Organization details">
        <dl className="auth-details">
          <div>
            <dt>Slug</dt>
            <dd>{org.slug}</dd>
          </div>
          <div>
            <dt>Time zone</dt>
            <dd>{org.defaultTimezone}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{org.status}</dd>
          </div>
        </dl>
      </section>
      <div className="m1-actions">
        <Button type="button" onClick={() => setDialog('edit')}>
          Edit organization
        </Button>
        <Button type="button" tone="quiet" onClick={() => setDialog('status')}>
          {statusLabel}
        </Button>
        <Button type="button" tone="quiet" disabled={suspended} onClick={() => setDialog('invite')}>
          Send owner invitation
        </Button>
      </div>
      {delivery && (
        <Notice alert={delivery === 'failed'}>
          {delivery === 'failed'
            ? 'The owner invitation email could not be delivered. You can resend it.'
            : 'The owner invitation was sent.'}
        </Notice>
      )}
      {dialog === 'edit' && (
        <FormDialog
          title="Edit organization"
          submit="Save changes"
          onClose={close}
          action={async (values) => {
            responseData(
              await apiClient.PATCH('/api/v1/admin/organizations/{id}', {
                params,
                body: {
                  name: textField(values, 'name'),
                  defaultTimezone: textField(values, 'timezone'),
                },
              }),
            );
            await cache.invalidateQueries({ queryKey: organizationsKey });
          }}
        >
          <label className="m1-field">
            Name
            <input name="name" defaultValue={org.name} required maxLength={200} />
          </label>
          <Timezone initial={org.defaultTimezone} />
        </FormDialog>
      )}
      {dialog === 'status' && (
        <Confirm
          title={statusLabel}
          submit={statusLabel}
          onClose={close}
          message={
            suspended
              ? 'Staff will regain access to this clinic.'
              : 'Staff will lose access to this clinic until it is reactivated.'
          }
          action={async () => {
            responseData(
              suspended
                ? await apiClient.POST('/api/v1/admin/organizations/{id}/reactivate', { params })
                : await apiClient.POST('/api/v1/admin/organizations/{id}/suspend', { params }),
            );
            await cache.invalidateQueries({ queryKey: organizationsKey });
          }}
        />
      )}
      {dialog === 'invite' && (
        <FormDialog
          title="Send owner invitation"
          submit="Send invitation"
          onClose={close}
          action={async (values) => {
            const result = responseData(
              await apiClient.POST('/api/v1/admin/organizations/{id}/owner-invitation', {
                params,
                body: {
                  email: textField(values, 'ownerEmail'),
                  fullName: textField(values, 'ownerName') || undefined,
                },
              }),
            );
            setDelivery(result.emailDelivery);
          }}
        >
          <OwnerFields />
        </FormDialog>
      )}
    </>
  );
}
