export const staffRoles = [
  'org_owner',
  'org_admin',
  'branch_manager',
  'doctor',
  'receptionist',
] as const;
export type StaffRole = (typeof staffRoles)[number];
export type Role = StaffRole | 'platform_admin' | 'patient';

/**
 * RBAC_MATRIX §3 row(s)                              | Permission
 * 3.1 platform.org.create / suspend / reactivate     | platform.org.manage
 *     platform.org.list                             | platform.org.manage
 *     org.read                                      | org.read
 *     org.update                                    | org.update
 *     org.ownership.transfer                        | org.ownership.transfer
 *     branch.create / deactivate                    | branch.manage
 *     branch.update                                 | branch.update
 *     member.list                                   | member.list
 *     member.invite / assign_role                   | member.manage
 *     member.remove                                 | member.manage
 *     audit.read                                    | audit.read
 *     audit.patient_access.read                     | audit.read
 * 3.2 doctor.profile.manage                         | doctor.schedule.manage
 *     availability.read                             | schedule.read
 *     availability.manage                           | doctor.schedule.manage
 *     slots.read                                    | slots.read
 *     appointment.read                              | appointment.read
 *     appointment.create                            | appointment.manage
 *     appointment.override_availability             | doctor.schedule.manage
 *     appointment.reschedule / cancel               | appointment.manage
 *     appointment.check_in / no_show                 | appointment.check_in
 *     appointment.complete                          | appointment.complete
 *     appointment_series.create / cancel             | appointment.series.manage
 * 3.3 patient.search / demographics.read            | patient.demographics
 *     patient.create                                | patient.demographics
 *     patient.demographics.update                   | patient.demographics
 *     patient.deactivate                            | patient.deactivate
 *     patient.portal_invite                         | patient.verify
 *     patient.verification_queue.read               | patient.verify
 *     patient.verify                                | patient.verify
 *     patient.mark_duplicate                        | patient.verify
 *     insurance_policy.read                         | patient.demographics
 *     insurance_policy.manage                       | insurance.manage
 * 3.4 chart.read                                    | clinical.read
 *     encounter.open / close                        | clinical.write
 *     encounter.patient_summary.write / release     | clinical.write
 *     visit_summary.read                            | clinical.released.read
 *     soap_note.read                                | clinical.read
 *     soap_note.write_draft / sign                   | clinical.write
 *     soap_note.amend                                | clinical.write
 *     diagnosis.read                                | clinical.released.read
 *     diagnosis.write                               | clinical.write
 *     allergy.write                                 | clinical.allergy.write
 *     prescription.read                            | clinical.released.read
 *     prescription.draft / sign / cancel             | clinical.write
 *     lab_order.create / cancel                     | clinical.write
 *     lab_order.read                                | lab.order.read
 *     lab_result.enter                              | clinical.write
 *     lab_result.release_to_patient                 | clinical.write
 *     lab_result.read                               | clinical.released.read
 *     file.upload / download                        | clinical.file.access
 * 3.5 service_code.read                             | service_code.read
 *     service_code.manage                           | service_code.manage
 *     invoice.read                                  | invoice.read
 *     invoice.create / edit_draft / issue            | billing.front_desk
 *     invoice.void                                  | billing.financial.manage
 *     payment.record_manual                         | billing.front_desk
 *     payment.pay_online                            | billing.pay_online
 *     insurance_claim.read / manage                 | claims.access
 *     report.financial.read                         | billing.financial.manage
 * 3.6 video_session.create                          | telehealth.create
 *     video_session.join                            | telehealth.participate
 *     video_session.end                             | telehealth.consult
 *     video_chat.read / send                        | telehealth.participate
 *     In-call chart view / Rx draft                  | telehealth.consult
 *
 * Public organization details and patient self-registration are separate entry points.
 * Resource checks enforce the matrix's action and field restrictions, including doctor calendar
 * redaction, released clinical data, patient read-only claim status, and in-call EMR permissions.
 */
export type Permission =
  | 'platform.org.manage'
  | 'org.read'
  | 'org.update'
  | 'org.ownership.transfer'
  | 'branch.manage'
  | 'branch.update'
  | 'member.list'
  | 'member.manage'
  | 'audit.read'
  | 'doctor.schedule.manage'
  | 'schedule.read'
  | 'slots.read'
  | 'appointment.read'
  | 'appointment.manage'
  | 'appointment.series.manage'
  | 'appointment.check_in'
  | 'appointment.complete'
  | 'patient.demographics'
  | 'patient.deactivate'
  | 'patient.verify'
  | 'insurance.manage'
  | 'clinical.read'
  | 'clinical.released.read'
  | 'clinical.write'
  | 'clinical.allergy.write'
  | 'lab.order.read'
  | 'clinical.file.access'
  | 'service_code.read'
  | 'service_code.manage'
  | 'invoice.read'
  | 'billing.front_desk'
  | 'billing.financial.manage'
  | 'billing.pay_online'
  | 'claims.access'
  | 'telehealth.create'
  | 'telehealth.participate'
  | 'telehealth.consult';

export type RoleScope = { role: Role; branchId: string | null };
export type Scope = 'P' | 'O' | 'B' | 'Own';
type PermissionScope = Scope | readonly ['B', 'Own'];

const organizationPermissions = {
  'org.read': 'O',
  'org.update': 'O',
  'branch.manage': 'O',
  'branch.update': 'O',
  'member.list': 'O',
  'member.manage': 'O',
  'audit.read': 'O',
  'doctor.schedule.manage': 'O',
  'schedule.read': 'O',
  'slots.read': 'O',
  'appointment.read': 'O',
  'appointment.manage': 'O',
  'appointment.series.manage': 'O',
  'patient.demographics': 'O',
  'patient.deactivate': 'O',
  'patient.verify': 'O',
  'insurance.manage': 'O',
  'service_code.read': 'O',
  'service_code.manage': 'O',
  'invoice.read': 'O',
  'billing.front_desk': 'O',
  'billing.financial.manage': 'O',
  'claims.access': 'O',
} as const;

export const rolePermissions: Record<Role, Partial<Record<Permission, PermissionScope>>> = {
  platform_admin: { 'platform.org.manage': 'P' },
  org_owner: { ...organizationPermissions, 'org.ownership.transfer': 'O' },
  org_admin: organizationPermissions,
  branch_manager: {
    'org.read': 'O',
    'branch.update': 'B',
    'member.list': 'B',
    'member.manage': 'B',
    'doctor.schedule.manage': 'B',
    'schedule.read': 'B',
    'slots.read': 'B',
    'appointment.read': 'B',
    'appointment.manage': 'B',
    'appointment.series.manage': 'B',
    'appointment.check_in': 'B',
    'patient.demographics': 'O',
    'patient.verify': 'O',
    'insurance.manage': 'O',
    'service_code.read': 'O',
    'invoice.read': 'B',
    'billing.front_desk': 'B',
    'billing.financial.manage': 'B',
    'claims.access': 'B',
    'telehealth.create': 'B',
  },
  doctor: {
    'org.read': 'O',
    'doctor.schedule.manage': 'Own',
    'schedule.read': 'B',
    'slots.read': 'B',
    'appointment.read': ['B', 'Own'],
    'appointment.manage': 'Own',
    'appointment.series.manage': 'Own',
    'appointment.check_in': 'Own',
    'appointment.complete': 'Own',
    'patient.demographics': 'O',
    'clinical.read': 'O',
    'clinical.released.read': 'O',
    'clinical.write': 'Own',
    'clinical.allergy.write': 'O',
    'lab.order.read': 'O',
    'clinical.file.access': 'O',
    'service_code.read': 'O',
    'telehealth.create': 'Own',
    'telehealth.participate': 'Own',
    'telehealth.consult': 'Own',
  },
  receptionist: {
    'org.read': 'O',
    'schedule.read': 'B',
    'slots.read': 'B',
    'appointment.read': 'B',
    'appointment.manage': 'B',
    'appointment.series.manage': 'B',
    'appointment.check_in': 'B',
    'patient.demographics': 'O',
    'patient.verify': 'O',
    'insurance.manage': 'O',
    'lab.order.read': 'B',
    'service_code.read': 'O',
    'invoice.read': 'B',
    'billing.front_desk': 'B',
    'claims.access': 'B',
    'telehealth.create': 'B',
  },
  patient: {
    'slots.read': 'O',
    'appointment.read': 'Own',
    'appointment.manage': 'Own',
    'patient.demographics': 'Own',
    'insurance.manage': 'Own',
    'clinical.released.read': 'Own',
    'clinical.file.access': 'Own',
    'invoice.read': 'Own',
    'billing.pay_online': 'Own',
    'claims.access': 'Own',
    'telehealth.participate': 'Own',
  },
};

export function hasScope(permissionScope: PermissionScope | undefined, scope: Scope): boolean {
  return typeof permissionScope === 'string'
    ? permissionScope === scope
    : (permissionScope?.some((assigned) => assigned === scope) ?? false);
}

export function isStaffRole(role: string): role is StaffRole {
  return staffRoles.some((staffRole) => staffRole === role);
}

const staffRoleRanks: Record<StaffRole, number> = {
  org_owner: 4,
  org_admin: 3,
  branch_manager: 2,
  doctor: 1,
  receptionist: 1,
};

function highestStaffRank(assignments: readonly Pick<RoleScope, 'role'>[]): number {
  return Math.max(
    0,
    ...assignments.map(({ role }) => (isStaffRole(role) ? staffRoleRanks[role] : 0)),
  );
}

export function outranksStaffMember(
  actor: readonly Pick<RoleScope, 'role'>[],
  target: readonly Pick<RoleScope, 'role'>[],
): boolean {
  return highestStaffRank(actor) > highestStaffRank(target);
}

export function canGrant(
  actorRoles: readonly RoleScope[],
  role: StaffRole,
  branchId: string | null,
): boolean {
  if (role === 'org_owner')
    return branchId === null && actorRoles.some((actor) => actor.role === 'platform_admin');
  if (role === 'org_admin')
    return branchId === null && actorRoles.some((actor) => actor.role === 'org_owner');
  if (branchId === null) return false;
  return actorRoles.some(
    (actor) =>
      actor.role === 'org_owner' ||
      actor.role === 'org_admin' ||
      (actor.role === 'branch_manager' && actor.branchId === branchId && role !== 'branch_manager'),
  );
}
