'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client/client';
import { responseData } from '@/lib/api-client/problems';
import type { components } from '@/lib/api-client/schema';
import { clinicKey, clinicParams, useBranches } from './clinic-data';
import { canManageBranch, hasPermission } from './permissions';
import { useClinic } from './shell';
import {
  Confirm,
  FormDialog,
  Heading,
  LoadError,
  Notice,
  Timezone,
  Unavailable,
  textField,
} from './ui';

type Branch = components['schemas']['BranchDto'];
type Dialog = { kind: 'create' } | { kind: 'edit' | 'status'; branch: Branch };

export function Branches() {
  const { roles } = useClinic();
  return hasPermission(roles, 'branch.update') || hasPermission(roles, 'branch.manage') ? (
    <BranchList />
  ) : (
    <Unavailable />
  );
}

function BranchList() {
  const { membership, roles } = useClinic();
  const orgId = membership.organizationId;
  const branches = useBranches(orgId);
  const cache = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>();
  const close = () => setDialog(undefined);
  const refresh = () => cache.invalidateQueries({ queryKey: clinicKey(orgId) });
  const creating = dialog?.kind === 'create';
  const editing = dialog?.kind === 'edit' ? dialog.branch : undefined;
  const statusBranch = dialog?.kind === 'status' ? dialog.branch : undefined;
  const statusAction =
    statusBranch?.status === 'active' ? 'Deactivate branch' : 'Reactivate branch';

  return (
    <>
      <Heading
        title="Branches"
        actions={
          canManageBranch(roles, 'branch.manage', null) && (
            <Button type="button" onClick={() => setDialog({ kind: 'create' })}>
              Create branch
            </Button>
          )
        }
      />
      {branches.isPending && <Notice>Loading branches…</Notice>}
      {branches.isError && <LoadError error={branches.error} />}
      {branches.data?.length === 0 && <p className="m1-empty">This clinic has no branches.</p>}
      {branches.data && branches.data.length > 0 && (
        <div className="m1-table-region">
          <table className="m1-table" aria-label="Branches">
            <thead>
              <tr>
                {['Code', 'Name', 'Time zone', 'Status', 'Actions'].map((label) => (
                  <th scope="col" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {branches.data.map((branch) => (
                <tr key={branch.id}>
                  <td>{branch.code}</td>
                  <td>{branch.name}</td>
                  <td>{branch.timezone}</td>
                  <td>{branch.status}</td>
                  <td>
                    <div className="m1-actions">
                      {canManageBranch(roles, 'branch.update', branch.id) && (
                        <Button
                          type="button"
                          tone="quiet"
                          onClick={() => setDialog({ kind: 'edit', branch })}
                        >
                          Edit
                        </Button>
                      )}
                      {canManageBranch(roles, 'branch.manage', branch.id) && (
                        <Button
                          type="button"
                          tone="quiet"
                          onClick={() => setDialog({ kind: 'status', branch })}
                        >
                          {branch.status === 'active' ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(creating || editing) && (
        <FormDialog
          title={creating ? 'Create branch' : 'Edit branch'}
          submit={creating ? 'Create branch' : 'Save changes'}
          onClose={close}
          action={async (data) => {
            const body = {
              name: textField(data, 'name'),
              code: textField(data, 'code'),
              timezone: textField(data, 'timezone'),
            };
            responseData(
              editing
                ? await apiClient.PATCH('/api/v1/orgs/{orgId}/branches/{id}', {
                    params: { path: { orgId, id: editing.id } },
                    body,
                  })
                : await apiClient.POST('/api/v1/orgs/{orgId}/branches', {
                    params: clinicParams(orgId),
                    body,
                  }),
            );
            await refresh();
          }}
        >
          <label className="m1-field">
            Code
            <input
              name="code"
              defaultValue={editing?.code}
              required
              pattern="[A-Z0-9\x2D]{2,16}"
              title="Use 2 to 16 uppercase letters, numbers or hyphens."
            />
          </label>
          <label className="m1-field">
            Name
            <input name="name" defaultValue={editing?.name} required maxLength={200} />
          </label>
          <Timezone initial={editing?.timezone} />
        </FormDialog>
      )}
      {statusBranch && (
        <Confirm
          title={statusAction}
          message={`${statusAction} for ${statusBranch.name}?`}
          submit={statusAction}
          onClose={close}
          action={async () => {
            responseData(
              await apiClient.PATCH('/api/v1/orgs/{orgId}/branches/{id}', {
                params: { path: { orgId, id: statusBranch.id } },
                body: { status: statusBranch.status === 'active' ? 'inactive' : 'active' },
              }),
            );
            await refresh();
          }}
        />
      )}
    </>
  );
}
