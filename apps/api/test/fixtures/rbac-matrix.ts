import type { Permission, Role, StaffRole } from '@clinik/shared';

/**
 * Independent conformance table transcribed by hand from docs/RBAC_MATRIX.md (v1.2).
 *
 * This file intentionally does NOT import any expected value from rbac.ts. Every cell below is
 * read from the matrix, then compared with the machine-readable catalogue. If the catalogue and
 * the matrix disagree, this test fails instead of agreeing with itself.
 *
 * Scope legend: P = platform, O = organization, B = assigned branches, Own = treating/linked.
 * An absent entry means the matrix has "â€”" (denied) for that role.
 */
export type MatrixScope = 'P' | 'O' | 'B' | 'Own' | readonly ['B', 'Own'];
type Expected = Partial<Record<Role, MatrixScope>>;

interface MatrixRow {
  row: string;
  permission: Permission;
  scopes: Expected;
}

export const matrixRows: readonly MatrixRow[] = [
  // 3.1 Platform & organization
  {
    row: 'platform.org.create / suspend / reactivate',
    permission: 'platform.org.manage',
    scopes: { platform_admin: 'P' },
  },
  { row: 'platform.org.list', permission: 'platform.org.manage', scopes: { platform_admin: 'P' } },
  {
    row: 'org.read',
    permission: 'org.read',
    // PT gets only the public subset through a separate entry point, not this permission.
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'O', doctor: 'O', receptionist: 'O' },
  },
  { row: 'org.update', permission: 'org.update', scopes: { org_owner: 'O', org_admin: 'O' } },
  {
    row: 'org.ownership.transfer',
    permission: 'org.ownership.transfer',
    scopes: { org_owner: 'O' },
  },
  {
    row: 'branch.create / deactivate',
    permission: 'branch.manage',
    scopes: { org_owner: 'O', org_admin: 'O' },
  },
  {
    row: 'branch.update',
    permission: 'branch.update',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'B' },
  },
  {
    row: 'member.list',
    permission: 'member.list',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'B' },
  },
  {
    row: 'member.invite / assign_role',
    permission: 'member.manage',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'B' },
  },
  {
    row: 'member.remove',
    permission: 'member.manage',
    // Footnote 2 (cannot remove owner/peer) is a service rule, not a scope difference.
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'B' },
  },
  { row: 'audit.read', permission: 'audit.read', scopes: { org_owner: 'O', org_admin: 'O' } },
  {
    row: 'audit.patient_access.read',
    permission: 'audit.read',
    scopes: { org_owner: 'O', org_admin: 'O' },
  },

  // 3.2 Doctors & scheduling
  {
    row: 'doctor.profile.manage',
    permission: 'doctor.schedule.manage',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'B', doctor: 'Own' },
  },
  {
    row: 'availability.read',
    permission: 'schedule.read',
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'B',
      doctor: 'B',
      receptionist: 'B',
    },
  },
  {
    row: 'availability.manage',
    permission: 'doctor.schedule.manage',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'B', doctor: 'Own' },
  },
  {
    row: 'slots.read',
    permission: 'slots.read',
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'B',
      doctor: 'B',
      receptionist: 'B',
      patient: 'O',
    },
  },
  {
    row: 'appointment.read',
    permission: 'appointment.read',
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'B',
      doctor: ['B', 'Own'],
      receptionist: 'B',
      patient: 'Own',
    },
  },
  {
    row: 'appointment.create',
    permission: 'appointment.manage',
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'B',
      doctor: 'Own',
      receptionist: 'B',
      patient: 'Own',
    },
  },
  {
    row: 'appointment.override_availability',
    permission: 'doctor.schedule.manage',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'B', doctor: 'Own' },
  },
  {
    row: 'appointment.reschedule / cancel',
    permission: 'appointment.manage',
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'B',
      doctor: 'Own',
      receptionist: 'B',
      patient: 'Own',
    },
  },
  {
    row: 'appointment.check_in / no_show',
    permission: 'appointment.check_in',
    scopes: { branch_manager: 'B', doctor: 'Own', receptionist: 'B' },
  },
  {
    row: 'appointment.complete',
    permission: 'appointment.complete',
    scopes: { doctor: 'Own' },
  },
  {
    row: 'appointment_series.create / cancel',
    permission: 'appointment.series.manage',
    // The matrix gives patients "â€”" for series, unlike create/reschedule/cancel.
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'B',
      doctor: 'Own',
      receptionist: 'B',
    },
  },

  // 3.3 Patients
  {
    row: 'patient.search / demographics.read',
    permission: 'patient.demographics',
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'O',
      doctor: 'O',
      receptionist: 'O',
      patient: 'Own',
    },
  },
  {
    row: 'patient.create',
    permission: 'patient.demographics',
    // PT self-registration creates their own record.
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'O',
      doctor: 'O',
      receptionist: 'O',
      patient: 'Own',
    },
  },
  {
    row: 'patient.demographics.update',
    permission: 'patient.demographics',
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'O',
      doctor: 'O',
      receptionist: 'O',
      patient: 'Own',
    },
  },
  {
    row: 'patient.deactivate',
    permission: 'patient.deactivate',
    scopes: { org_owner: 'O', org_admin: 'O' },
  },
  {
    row: 'patient.portal_invite',
    permission: 'patient.verify',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'O', receptionist: 'O' },
  },
  {
    row: 'patient.verification_queue.read',
    permission: 'patient.verify',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'O', receptionist: 'O' },
  },
  {
    row: 'patient.verify',
    permission: 'patient.verify',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'O', receptionist: 'O' },
  },
  {
    row: 'patient.mark_duplicate',
    permission: 'patient.verify',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'O', receptionist: 'O' },
  },
  {
    row: 'insurance_policy.read',
    permission: 'patient.demographics',
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'O',
      doctor: 'O',
      receptionist: 'O',
      patient: 'Own',
    },
  },
  {
    row: 'insurance_policy.manage',
    permission: 'insurance.manage',
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'O',
      receptionist: 'O',
      patient: 'Own',
    },
  },

  // 3.4 Clinical records (EMR)
  { row: 'chart.read', permission: 'clinical.read', scopes: { doctor: 'O' } },
  { row: 'encounter.open / close', permission: 'clinical.write', scopes: { doctor: 'Own' } },
  {
    row: 'encounter.patient_summary.write / release',
    permission: 'clinical.write',
    scopes: { doctor: 'Own' },
  },
  {
    row: 'visit_summary.read',
    permission: 'clinical.released.read',
    scopes: { doctor: 'O', patient: 'Own' },
  },
  { row: 'soap_note.read', permission: 'clinical.read', scopes: { doctor: 'O' } },
  {
    row: 'soap_note.write_draft / sign',
    permission: 'clinical.write',
    scopes: { doctor: 'Own' },
  },
  { row: 'soap_note.amend', permission: 'clinical.write', scopes: { doctor: 'Own' } },
  {
    row: 'diagnosis.read',
    permission: 'clinical.released.read',
    scopes: { doctor: 'O', patient: 'Own' },
  },
  { row: 'diagnosis.write', permission: 'clinical.write', scopes: { doctor: 'Own' } },
  { row: 'allergy.write', permission: 'clinical.allergy.write', scopes: { doctor: 'O' } },
  {
    row: 'prescription.read',
    permission: 'clinical.released.read',
    scopes: { doctor: 'O', patient: 'Own' },
  },
  {
    row: 'prescription.draft / sign / cancel',
    permission: 'clinical.write',
    scopes: { doctor: 'Own' },
  },
  { row: 'lab_order.create / cancel', permission: 'clinical.write', scopes: { doctor: 'Own' } },
  {
    row: 'lab_order.read',
    permission: 'lab.order.read',
    scopes: { doctor: 'O', receptionist: 'B' },
  },
  { row: 'lab_result.enter', permission: 'clinical.write', scopes: { doctor: 'Own' } },
  {
    row: 'lab_result.release_to_patient',
    permission: 'clinical.write',
    scopes: { doctor: 'Own' },
  },
  {
    row: 'lab_result.read',
    permission: 'clinical.released.read',
    scopes: { doctor: 'O', patient: 'Own' },
  },
  {
    row: 'file.upload / download',
    permission: 'clinical.file.access',
    scopes: { doctor: 'O', patient: 'Own' },
  },

  // 3.5 Billing & payments
  {
    row: 'service_code.read',
    permission: 'service_code.read',
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'O',
      doctor: 'O',
      receptionist: 'O',
    },
  },
  {
    row: 'service_code.manage',
    permission: 'service_code.manage',
    scopes: { org_owner: 'O', org_admin: 'O' },
  },
  {
    row: 'invoice.read',
    permission: 'invoice.read',
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'B',
      receptionist: 'B',
      patient: 'Own',
    },
  },
  {
    row: 'invoice.create / edit_draft / issue',
    permission: 'billing.front_desk',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'B', receptionist: 'B' },
  },
  {
    row: 'invoice.void',
    permission: 'billing.financial.manage',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'B' },
  },
  {
    row: 'payment.record_manual',
    permission: 'billing.front_desk',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'B', receptionist: 'B' },
  },
  { row: 'payment.pay_online', permission: 'billing.pay_online', scopes: { patient: 'Own' } },
  {
    row: 'insurance_claim.read / manage',
    permission: 'claims.access',
    scopes: {
      org_owner: 'O',
      org_admin: 'O',
      branch_manager: 'B',
      receptionist: 'B',
      patient: 'Own',
    },
  },
  {
    row: 'report.financial.read',
    permission: 'billing.financial.manage',
    scopes: { org_owner: 'O', org_admin: 'O', branch_manager: 'B' },
  },

  // 3.6 Telehealth
  {
    row: 'video_session.create',
    permission: 'telehealth.create',
    scopes: { branch_manager: 'B', doctor: 'Own', receptionist: 'B' },
  },
  {
    row: 'video_session.join',
    permission: 'telehealth.participate',
    scopes: { doctor: 'Own', patient: 'Own' },
  },
  { row: 'video_session.end', permission: 'telehealth.consult', scopes: { doctor: 'Own' } },
  {
    row: 'video_chat.read / send',
    permission: 'telehealth.participate',
    scopes: { doctor: 'Own', patient: 'Own' },
  },
  {
    row: 'In-call chart view / Rx draft',
    permission: 'telehealth.consult',
    scopes: { doctor: 'Own' },
  },
];

export const matrixRoles: readonly Role[] = [
  'platform_admin',
  'org_owner',
  'org_admin',
  'branch_manager',
  'doctor',
  'receptionist',
  'patient',
];

export function matrixScopesFor(permission: Permission): Expected {
  const row = matrixRows.find((candidate) => candidate.permission === permission);
  if (!row) throw new Error(`No RBAC matrix row for ${permission}`);
  return row.scopes;
}

export const matrixStaffRanks: Readonly<Record<StaffRole, number>> = {
  org_owner: 4,
  org_admin: 3,
  branch_manager: 2,
  doctor: 1,
  receptionist: 1,
};
