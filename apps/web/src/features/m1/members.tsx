'use client';

import { canGrant, isStaffRole, type RoleScope } from '@clinik/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client/client';
import { checkResponse, responseData } from '@/lib/api-client/problems';
import type { components } from '@/lib/api-client/schema';
import { clinicKey, clinicParams, useBranches, useMembers } from './clinic-data';
import {
  canEditRoles,
  canManageBranch,
  hasPermission,
  roleAssignmentHints,
  roleLabel,
  roleOptions,
} from './permissions';
import { meKey } from './session';
import { useClinic } from './shell';
import {
  Confirm,
  FormDialog,
  Heading,
  LoadError,
  LoadMore,
  Notice,
  Unavailable,
  textField,
} from './ui';

type Member = components['schemas']['MemberDto'];
type Assignment = components['schemas']['StaffAssignmentDto'];
type Invitation = components['schemas']['InvitationListItemDto'];
type Option = ReturnType<typeof roleOptions>[number];
type Dialog = { kind: 'invite' } | { kind: 'roles' | 'remove'; member: Member };
const assignmentKey = ({ role, branchId }: Assignment) => `${role}:${branchId ?? ''}`;

function scopeName(branchNames: ReadonlyMap<string, string>, id?: string | null) {
  return id ? (branchNames.get(id) ?? 'Assigned branch') : 'All branches';
}

export function Members() {
  const { roles } = useClinic();
  return hasPermission(roles, 'member.list') ? <MemberWorkspace /> : <Unavailable />;
}

function MemberWorkspace() {
  const { membership, roles, user } = useClinic();
  const orgId = membership.organizationId;
  const [tab, setTab] = useState<'members' | 'invitations'>('members');
  const [dialog, setDialog] = useState<Dialog>();
  const [delivery, setDelivery] = useState<'sent' | 'failed'>();
  const cache = useQueryClient();
  const members = useMembers(orgId, tab === 'members');
  const branches = useBranches(orgId);
  const branchNames = new Map(branches.data?.map(({ id, name }) => [id, name]));
  const options = roleOptions(roles, branches.data ?? []);
  const ownAssignments = roles.flatMap(({ role, branchId }) =>
    isStaffRole(role) ? [{ role, branchId }] : [],
  );
  const refresh = () => cache.invalidateQueries({ queryKey: clinicKey(orgId) });
  const close = () => setDialog(undefined);

  return (
    <>
      <Heading
        title="Members"
        actions={
          options.length > 0 && (
            <Button
              type="button"
              onClick={() => {
                setDelivery(undefined);
                setDialog({ kind: 'invite' });
              }}
            >
              Invite staff
            </Button>
          )
        }
      />
      <div className="m1-tabs" role="group" aria-label="Member views">
        <Button
          type="button"
          tone="quiet"
          aria-pressed={tab === 'members'}
          onClick={() => setTab('members')}
        >
          Staff members
        </Button>
        <Button
          type="button"
          tone="quiet"
          aria-pressed={tab === 'invitations'}
          onClick={() => setTab('invitations')}
        >
          Pending invitations
        </Button>
      </div>
      {delivery && (
        <Notice alert={delivery === 'failed'}>
          {delivery === 'failed'
            ? 'The invitation was created, but the email could not be delivered.'
            : 'Invitation sent.'}
        </Notice>
      )}
      {branches.isError && <LoadError error={branches.error} />}
      {tab === 'invitations' ? (
        <InvitationList branchNames={branchNames} />
      ) : (
        <>
          {members.isPending && <Notice>Loading staff members…</Notice>}
          {members.isError && <LoadError error={members.error} />}
          {members.data?.length === 0 && (
            <p className="m1-empty">There are no staff members in your view.</p>
          )}
          {!!members.data?.length && (
            <div className="m1-table-region">
              <table className="m1-table" aria-label="Staff members">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col">Roles and branches</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {members.data.map((member) => {
                    const isSelf = member.userId === user.id;
                    const targetRoles = isSelf ? ownAssignments : member.roles;
                    const canEdit =
                      member.canEditRoles &&
                      canEditRoles(roles, targetRoles, isSelf) &&
                      (isSelf ||
                        options.length > 0 ||
                        targetRoles.some(({ role, branchId }) =>
                          canGrant(roles, role, branchId ?? null),
                        ));
                    return (
                      <tr key={member.userId}>
                        <td>
                          {member.fullName}
                          {isSelf && ' (you)'}
                        </td>
                        <td>{member.email}</td>
                        <td>
                          {member.roles.length ? (
                            <ul>
                              {member.roles.map((assignment) => (
                                <li key={assignmentKey(assignment)}>
                                  {roleLabel[assignment.role]} ·{' '}
                                  {scopeName(branchNames, assignment.branchId)}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            'No roles'
                          )}
                        </td>
                        <td>
                          <div className="m1-actions">
                            {canEdit && (
                              <Button
                                type="button"
                                tone="quiet"
                                onClick={() =>
                                  setDialog({
                                    kind: 'roles',
                                    member: { ...member, roles: targetRoles },
                                  })
                                }
                              >
                                Edit roles
                              </Button>
                            )}
                            {member.canRemove && (
                              <Button
                                type="button"
                                tone="quiet"
                                onClick={() => setDialog({ kind: 'remove', member })}
                              >
                                Remove
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {dialog?.kind === 'invite' && (
        <InviteDialog
          options={options}
          branchNames={branchNames}
          onClose={close}
          send={async (email, assignment) => {
            const result = responseData(
              await apiClient.POST('/api/v1/orgs/{orgId}/invitations', {
                params: clinicParams(orgId),
                body: { email, ...assignment },
              }),
            );
            setDelivery(result.emailDelivery);
            await refresh();
          }}
        />
      )}
      {dialog?.kind === 'roles' && (
        <RoleEditor
          member={dialog.member}
          actor={roles}
          isSelf={dialog.member.userId === user.id}
          options={options}
          branchNames={branchNames}
          onClose={close}
          save={async (assignments) => {
            const { response, error } = await apiClient.PUT(
              '/api/v1/orgs/{orgId}/members/{userId}/roles',
              {
                params: { path: { orgId, userId: dialog.member.userId } },
                body: { roles: assignments },
              },
            );
            checkResponse(response, error);
            await refresh();
            if (dialog.member.userId === user.id)
              await cache.invalidateQueries({ queryKey: meKey });
          }}
        />
      )}
      {dialog?.kind === 'remove' && (
        <Confirm
          title="Remove member"
          submit="Remove member"
          onClose={close}
          message={`Remove ${dialog.member.fullName} from this clinic and end their sign-in sessions?`}
          action={async () => {
            const { response, error } = await apiClient.DELETE(
              '/api/v1/orgs/{orgId}/members/{userId}',
              {
                params: { path: { orgId, userId: dialog.member.userId } },
              },
            );
            checkResponse(response, error);
            await refresh();
          }}
        />
      )}
    </>
  );
}

function InviteDialog({
  options,
  branchNames,
  onClose,
  send,
}: {
  options: Option[];
  branchNames: ReadonlyMap<string, string>;
  onClose: () => void;
  send: (email: string, assignment: Option) => Promise<void>;
}) {
  const [role, setRole] = useState('');
  const roleChoices = [...new Set(options.map((option) => option.role))];
  const selected = options.filter((option) => option.role === role && option.branchId !== null);
  return (
    <FormDialog
      title="Invite staff"
      submit="Send invitation"
      onClose={onClose}
      action={async (data) => {
        const branchId = textField(data, 'branch') || null;
        const assignment = options.find(
          (option) => option.role === role && option.branchId === branchId,
        );
        if (!assignment) throw new Error('Unknown role or branch');
        await send(textField(data, 'email'), assignment);
      }}
    >
      <label className="m1-field">
        Email
        <input name="email" type="email" required maxLength={254} />
      </label>
      <label className="m1-field">
        Role
        <select
          aria-label="Role"
          name="role"
          value={role}
          onChange={(event) => setRole(event.target.value)}
          required
        >
          <option value="" disabled>
            Choose a role
          </option>
          {roleChoices.map((choice) => (
            <option key={choice} value={choice}>
              {roleLabel[choice]}
            </option>
          ))}
        </select>
      </label>
      {selected.length > 0 && (
        <label className="m1-field">
          Branch
          <select
            aria-label="Branch"
            name="branch"
            key={role}
            defaultValue={selected.length === 1 ? (selected[0].branchId ?? '') : ''}
            required
          >
            <option value="" disabled>
              Choose a branch
            </option>
            {selected.map(({ branchId }) => (
              <option key={branchId} value={branchId ?? ''}>
                {scopeName(branchNames, branchId)}
              </option>
            ))}
          </select>
        </label>
      )}
    </FormDialog>
  );
}

function RoleEditor({
  member,
  actor,
  isSelf,
  options,
  branchNames,
  onClose,
  save,
}: {
  member: Member;
  actor: readonly RoleScope[];
  isSelf: boolean;
  options: Option[];
  branchNames: ReadonlyMap<string, string>;
  onClose: () => void;
  save: (assignments: Assignment[]) => Promise<void>;
}) {
  const assigned = new Set(member.roles.map(assignmentKey));
  const [selected, setSelected] = useState(() => assigned);
  const candidates = [
    ...member.roles,
    ...(isSelf ? [] : options.filter((option) => !assigned.has(assignmentKey(option)))),
  ].map((assignment) => {
    const key = assignmentKey(assignment);
    const editable = isSelf
      ? assignment.role !== 'org_owner'
      : canGrant(actor, assignment.role, assignment.branchId ?? null);
    return { assignment, key, editable, checked: (editable ? selected : assigned).has(key) };
  });
  const assignments = candidates
    .filter(({ checked }) => checked)
    .map(({ assignment }) => assignment);
  return (
    <FormDialog
      title={`Edit roles for ${member.fullName}`}
      submit="Save roles"
      submitDisabled={
        assignments.length === 0 || (isSelf && assignments.length === member.roles.length)
      }
      onClose={onClose}
      action={() => save(assignments)}
    >
      <div className="m1-checkboxes">
        {candidates.map(({ assignment, key, editable, checked }) => (
          <label key={key}>
            <input
              type="checkbox"
              name="assignment"
              value={key}
              checked={checked}
              disabled={!editable}
              onChange={(event) => {
                const isChecked = event.currentTarget.checked;
                setSelected((current) => {
                  const next = new Set(current);
                  if (isChecked) next.add(key);
                  else next.delete(key);
                  return next;
                });
              }}
            />
            {roleLabel[assignment.role]} · {scopeName(branchNames, assignment.branchId)}
          </label>
        ))}
      </div>
      {roleAssignmentHints(assignments).map((hint) => (
        <Notice key={hint}>{hint}</Notice>
      ))}
    </FormDialog>
  );
}

function InvitationList({ branchNames }: { branchNames: ReadonlyMap<string, string> }) {
  const { membership, roles } = useClinic();
  const orgId = membership.organizationId;
  const cache = useQueryClient();
  const [status, setStatus] = useState<'pending' | 'all'>('pending');
  const [revoking, setRevoking] = useState<Invitation>();
  const invitations = useInfiniteQuery({
    queryKey: [...clinicKey(orgId), 'invitations', status],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      responseData(
        await apiClient.GET('/api/v1/orgs/{orgId}/invitations', {
          params: { ...clinicParams(orgId), query: { status, cursor: pageParam } },
          signal,
        }),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = invitations.data?.pages.flatMap(({ items }) => items) ?? [];
  return (
    <>
      <div className="m1-inline-form">
        <label className="m1-field">
          Invitation status
          <select
            aria-label="Invitation status"
            value={status}
            onChange={(event) => setStatus(event.target.value === 'all' ? 'all' : 'pending')}
          >
            <option value="pending">Pending</option>
            <option value="all">All statuses</option>
          </select>
        </label>
      </div>
      {invitations.isPending && <Notice>Loading invitations…</Notice>}
      {invitations.isError && !invitations.data && <LoadError error={invitations.error} />}
      {invitations.isSuccess && items.length === 0 && (
        <p className="m1-empty">No invitations match this status.</p>
      )}
      {items.length > 0 && (
        <div className="m1-table-region">
          <table className="m1-table" aria-label="Invitations">
            <thead>
              <tr>
                {['Email', 'Role', 'Branch', 'Status', 'Actions'].map((name) => (
                  <th key={name} scope="col">
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.email}</td>
                  <td>{roleLabel[item.role]}</td>
                  <td>{scopeName(branchNames, item.branchId)}</td>
                  <td>{item.status}</td>
                  <td>
                    {item.status === 'pending' &&
                      canManageBranch(roles, 'member.manage', item.branchId) && (
                        <Button type="button" tone="quiet" onClick={() => setRevoking(item)}>
                          Revoke
                        </Button>
                      )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {invitations.hasNextPage && (
        <LoadMore
          load={() => void invitations.fetchNextPage()}
          busy={invitations.isFetchingNextPage}
          error={invitations.isFetchNextPageError ? invitations.error : null}
        />
      )}
      {revoking && (
        <Confirm
          title="Revoke invitation"
          message={`Cancel the invitation for ${revoking.email}?`}
          submit="Revoke invitation"
          onClose={() => setRevoking(undefined)}
          action={async () => {
            const { response, error } = await apiClient.DELETE(
              '/api/v1/orgs/{orgId}/invitations/{id}',
              {
                params: { path: { orgId, id: revoking.id } },
              },
            );
            checkResponse(response, error);
            await cache.invalidateQueries({ queryKey: [...clinicKey(orgId), 'invitations'] });
          }}
        />
      )}
    </>
  );
}
