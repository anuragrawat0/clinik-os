'use client';

import { isStaffRole } from '@clinik/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client/client';
import { checkResponse, responseData } from '@/lib/api-client/problems';
import { clinicKey, clinicParams, useBranches, useMembers } from './clinic-data';
import { hasPermission, organizationNavigation, roleLabel } from './permissions';
import { meKey } from './session';
import { clinicPath, useClinic } from './shell';
import {
  FormDialog,
  Heading,
  LoadError,
  Notice,
  Timezone,
  Unavailable,
  textField,
  useSingleFlightSubmit,
} from './ui';

export function Dashboard() {
  const { membership, roles } = useClinic();
  const hasBranchAssignments = roles.some(({ branchId }) => branchId !== null);
  const branches = useBranches(membership.organizationId, hasBranchAssignments);
  const labels = new Map(branches.data?.map(({ id, name }) => [id, name]));
  const links = organizationNavigation(roles).filter(({ path }) => path);
  return (
    <>
      <Heading title={membership.organizationName} />
      <section className="m1-panel">
        <h2>Your roles</h2>
        {hasBranchAssignments && branches.isError && <LoadError error={branches.error} />}
        {roles.length ? (
          <ul>
            {roles.map(({ role, branchId }) => (
              <li key={`${role}:${branchId ?? ''}`}>
                {isStaffRole(role) ? roleLabel[role] : role}
                {branchId !== null
                  ? ` · ${labels.get(branchId) ?? 'Assigned branch'}`
                  : ' · All branches'}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m1-empty">You have no assigned staff roles.</p>
        )}
      </section>
      {links.length > 0 && (
        <section className="m1-panel">
          <h2>Quick links</h2>
          <div className="m1-actions">
            {links.map(({ path, label }) => (
              <Link
                className="m1-back"
                key={path}
                href={clinicPath(membership.organizationSlug) + path}
              >
                {label}
              </Link>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

export function OrganizationSettings() {
  const { roles } = useClinic();
  return hasPermission(roles, 'org.update') ? <Settings /> : <Unavailable />;
}

function Settings() {
  const { membership, roles, user } = useClinic();
  const orgId = membership.organizationId;
  const cache = useQueryClient();
  const [transfer, setTransfer] = useState(false);
  const [transferred, setTransferred] = useState(false);
  const runSubmit = useSingleFlightSubmit();
  const canTransfer = hasPermission(roles, 'org.ownership.transfer');
  const members = useMembers(orgId, canTransfer);
  const org = useQuery({
    queryKey: [...clinicKey(orgId), 'settings'],
    queryFn: async ({ signal }) =>
      responseData(
        await apiClient.GET('/api/v1/orgs/{orgId}', {
          params: clinicParams(orgId),
          signal,
        }),
      ),
  });
  const save = useMutation({
    mutationFn: async (data: FormData) =>
      responseData(
        await apiClient.PATCH('/api/v1/orgs/{orgId}', {
          params: clinicParams(orgId),
          body: { name: textField(data, 'name'), defaultTimezone: textField(data, 'timezone') },
        }),
      ),
    onSuccess: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: clinicKey(orgId) }),
        cache.invalidateQueries({ queryKey: meKey }),
      ]);
    },
  });
  const candidates = members.data?.filter(({ userId }) => userId !== user.id) ?? [];

  return (
    <>
      <Heading title="Settings" />
      {org.isPending && <Notice>Loading settings…</Notice>}
      {org.isError && <LoadError error={org.error} />}
      {org.data && (
        <section className="m1-panel">
          <h2>Clinic details</h2>
          <form
            className="m1-form"
            key={org.data.updatedAt}
            onSubmit={(event) => {
              event.preventDefault();
              void runSubmit(() => save.mutateAsync(new FormData(event.currentTarget)));
            }}
          >
            <fieldset disabled={save.isPending}>
              <label className="m1-field">
                Name
                <input name="name" defaultValue={org.data.name} required maxLength={200} />
              </label>
              <Timezone initial={org.data.defaultTimezone} />
            </fieldset>
            {save.isError && <LoadError error={save.error} />}
            {save.isSuccess && <Notice>Settings saved.</Notice>}
            <div>
              <Button type="submit" disabled={save.isPending}>
                Save settings
              </Button>
            </div>
          </form>
        </section>
      )}
      {transferred && <Notice>Ownership transferred.</Notice>}
      {canTransfer && (
        <section className="m1-panel">
          <h2>Ownership</h2>
          {members.isError && <LoadError error={members.error} />}
          {members.isSuccess && !candidates.length && (
            <p className="m1-empty">Invite another active member before transferring ownership.</p>
          )}
          <Button
            type="button"
            tone="quiet"
            disabled={!candidates.length}
            onClick={() => setTransfer(true)}
          >
            Transfer ownership
          </Button>
        </section>
      )}
      {canTransfer && transfer && (
        <FormDialog
          title="Transfer ownership"
          submit="Confirm transfer"
          onClose={() => setTransfer(false)}
          action={async (data) => {
            const { response, error } = await apiClient.POST(
              '/api/v1/orgs/{orgId}/ownership-transfer',
              {
                params: clinicParams(orgId),
                body: {
                  newOwnerUserId: textField(data, 'member'),
                  currentPassword: String(data.get('password') ?? ''),
                },
              },
            );
            checkResponse(response, error);
            setTransfer(false);
            setTransferred(true);
            await Promise.all([
              cache.invalidateQueries({ queryKey: clinicKey(orgId) }),
              cache.invalidateQueries({ queryKey: meKey }),
            ]);
          }}
        >
          <p>The selected member will become the clinic owner.</p>
          <label className="m1-field">
            New owner
            <select aria-label="New owner" name="member" defaultValue="" required>
              <option value="" disabled>
                Choose an active member
              </option>
              {candidates.map(({ userId, fullName, email }) => (
                <option key={userId} value={userId}>
                  {fullName} ({email})
                </option>
              ))}
            </select>
          </label>
          <label className="m1-field">
            Current password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
        </FormDialog>
      )}
    </>
  );
}
