# RBAC Matrix — Clinik OS

Status: **approved, v1.2.** All seven roles from the brief are kept. v1.2 only removes rows for features that were simplified (D18, D19, D11r). Applies decisions D1, D2, D3, D5, D6 and D19 ([ARCHITECTURE.md §11](ARCHITECTURE.md#11-decisions-and-assumptions)). Cells that depend on an accepted decision are tagged with its ID. Cells marked † depend on still-open decision D14.

## 1. Roles

| Code | Role | Level | Assigned via | Purpose |
|---|---|---|---|---|
| PA | Platform Administrator | Platform | `users.is_platform_admin` | Provision and suspend organizations. **No tenant data, no PHI** (A4) |
| OO | Organization Owner | Organization | `staff_role_assignments(role='org_owner', branch_id NULL)` | Legal/commercial owner. Exactly one per org |
| OA | Organization Administrator | Organization | `org_admin`, branch NULL | Runs the org: branches, staff, pricing, billing oversight |
| BM | Branch Manager | Branch | `branch_manager`, one row per branch | Runs one or more branches: staff schedules, front desk, billing |
| DR | Doctor | Branch | `doctor`, one row per branch where they practice | Clinical care |
| RC | Receptionist | Branch | `receptionist`, per branch | Front desk: registration, booking, check-in, invoicing, payments |
| PT | Patient | Self | `patient_accounts` | Own appointments, records, bills |

Roles are additive. A user can hold several, for example OO + DR @ Branch A, and the effective permission is the union.

## 2. Scope legend

| Symbol | Meaning |
|---|---|
| **O** | Any resource in the organization |
| **B** | Resources whose `branch_id` is one of the actor's assigned branches for that role |
| **Own** | DR: resources where they are the treating/authoring doctor (`appointment.doctor_id`, `encounter.doctor_id`) or their own profile. PT: resources of a patient linked to their account |
| **P** | Platform-wide, non-PHI only |
| — | Denied |

Patients are **org-level** records (D1), so patient demographics use **O** even for branch roles. A receptionist at Branch A can find and book a patient first registered at Branch B.

## 3. Permission matrix

### 3.1 Platform & organization

| Permission | PA | OO | OA | BM | DR | RC | PT |
|---|---|---|---|---|---|---|---|
| `platform.org.create / suspend / reactivate` | P | — | — | — | — | — | — |
| `platform.org.list` (name, status, counts only) | P | — | — | — | — | — | — |
| `org.read` (name, branches, settings) | — | O | O | O | O | O | public subset¹ |
| `org.update` (settings, currency, timezone) | — | O | O | — | — | — | — |
| `org.ownership.transfer` | — | O | — | — | — | — | — |
| `branch.create / deactivate` | — | O | O | — | — | — | — |
| `branch.update` | — | O | O | B | — | — | — |
| `member.list` | — | O | O | B | — | — | — |
| `member.invite / assign_role` (see §4 grant rules) | — | O | O | B | — | — | — |
| `member.remove` | — | O | O² | B² | — | — | — |
| `audit.read` (org audit log) | — | O | O | — | — | — | — |
| `audit.patient_access.read` ("who viewed patient X") | — | O | O | — | — | — | — |

Synthea data is loaded by a developer CLI (D18), so there is no in-app import permission. ¹ Portal shows org name, branches and bookable doctors only. ² Cannot remove the owner or a peer with an equal or higher role.

### 3.2 Doctors & scheduling

| Permission | PA | OO | OA | BM | DR | RC | PT |
|---|---|---|---|---|---|---|---|
| `doctor.profile.manage` | — | O | O | B | Own³ | — | — |
| `availability.read` | — | O | O | B | B | B | — |
| `availability.manage` (rules, exceptions) | — | O | O | B | Own | — | — |
| `slots.read` | — | O | O | B | B | B | O (bookable only) |
| `appointment.read` | — | O | O | B | Own + B calendar⁴ | B | Own |
| `appointment.create` | — | O | O | B | Own | B | Own |
| `appointment.override_availability` (book outside hours) | — | O | O | B | Own | — | — |
| `appointment.reschedule / cancel` | — | O | O | B | Own | B | Own (≥ 24 h before, A14) |
| `appointment.check_in / no_show` | — | — | — | B | Own | B | — |
| `appointment.complete` | — | — | — | — | Own | — | — |
| `appointment_series.create / cancel` | — | O | O | B | Own | B | — |

³ Bio, specialty and default slot length. Registration number is editable by OO/OA/BM only. ⁴ Doctors see the branch calendar as time blocks plus patient name, which is needed for coordination. Appointment *reason* is visible only for their own appointments.

### 3.3 Patients

| Permission | PA | OO | OA | BM | DR | RC | PT |
|---|---|---|---|---|---|---|---|
| `patient.search / demographics.read` | — | O | O | O | O | O | Own |
| `patient.create` (duplicate warning; `verified` on create) | — | O | O | O | O | O | self-register⁵ |
| `patient.demographics.update` | — | O | O | O | O | O | Own (contact fields only) |
| `patient.deactivate` | — | O | O | — | — | — | — |
| `patient.portal_invite` | — | O | O | O | — | O | — |
| `patient.verification_queue.read` (pending records + possible duplicates) | — | O | O | O | — | O | — |
| `patient.verify` (verify as new) | — | O | O | O | — | O | — |
| `patient.mark_duplicate` (set the record `inactive` with a reason; no relink, no merge, D19) | — | O | O | O | — | O | — |
| `insurance_policy.read` | — | O | O | O | O | O | Own |
| `insurance_policy.manage` | — | O | O | O | — | O | Own (add/update) |

⁵ Self-registration through the portal creates a **`pending`** patient in that org and runs the duplicate warning query. The response doesn't reveal matches. The patient may book, but encounters and invoices need staff verification (D6). Doctors are deliberately excluded from verification so that identity decisions stay with the front desk and management.

### 3.4 Clinical records (EMR)

| Permission | PA | OO | OA | BM | DR | RC | PT |
|---|---|---|---|---|---|---|---|
| `chart.read` (problems, allergies, meds, labs, encounters), **audited** | — | — (D3) | — (D3) | — | O (D2) | — | — |
| `encounter.open / close` (patient must be `verified`) | — | — | — | — | Own | — | — |
| `encounter.patient_summary.write / release` | — | — | — | — | Own | — | — |
| `visit_summary.read` (closed encounters; released summary text) | — | — | — | — | O (D2) | — | Own (D5) |
| `soap_note.read`, **audited** | — | — (D3) | — (D3) | — | O (D2) | — | — (D5) |
| `soap_note.write_draft / sign` | — | — | — | — | Own (encounter doctor) | — | — |
| `soap_note.amend` | — | — | — | — | Own (encounter doctor) | — | — |
| `diagnosis.read`, **audited** | — | — | — | — | O (D2) | — | Own, `confirmed` only (D5) |
| `diagnosis.write` | — | — | — | — | Own encounter | — | — |
| `allergy.write` | — | — | — | — | O | — | — |
| `prescription.read`, **audited** | — | — | — | — | O (D2) | — | Own, signed + active/completed only (D5) |
| `prescription.draft / sign / cancel` | — | — | — | — | Own encounter | — | — |
| `lab_order.create / cancel` | — | — | — | — | Own encounter | — | — |
| `lab_order.read` | — | — | — | — | O | Status only, B⁶ | — |
| `lab_result.enter` | — | — | — | — | Own order †(D14) | — | — |
| `lab_result.release_to_patient` | — | — | — | — | Own order | — | — |
| `lab_result.read`, **audited** | — | — | — | — | O (D2) | — | Own, released only (D5) |
| `file.upload / download` (clinical), **audited** | — | — | — | — | O (D2) | — | Own (released lab reports) |

⁶ Receptionist sees "lab order pending/resulted" for front-desk follow-up, not values.

**Rules**
- Clinical permissions come **only** from the `doctor` role. Org owners who treat patients get a doctor assignment (D3). The DB also enforces that only the encounter's doctor can author notes, prescriptions and lab orders (composite FK).
- **D2 scope:** "O" for doctors means any patient in the organization. Every read writes an audit row. The planned post-MVP narrowing to a treating relationship or authorized branches changes only `access.canReadClinicalRecord`. The matrix cells would change from **O** to **Own-care** or **B** (ARCHITECTURE §5).
- **Patients never receive SOAP note content (D5)**, including in the visit summary. The summary text is a separate field the doctor writes and releases.

### 3.5 Billing & payments

| Permission | PA | OO | OA | BM | DR | RC | PT |
|---|---|---|---|---|---|---|---|
| `service_code.read` | — | O | O | O | O | O | — |
| `service_code.manage` | — | O | O | — | — | — | — |
| `invoice.read` | — | O | O | B | —⁷ | B | Own (issued only) |
| `invoice.create / edit_draft / issue` (no tax; patient must be `verified`) | — | O | O | B | — | B | — |
| `invoice.void` | — | O | O | B | — | — | — |
| `payment.record_manual` (cash, terminal, bank) | — | O | O | B | — | B | — |
| `payment.pay_online` (Stripe Checkout) | — | — | — | — | — | — | Own |
| `insurance_claim.read / manage` | — | O | O | B | — | B | Own (read status) |
| `report.financial.read` | — | O | O | B | — | — | — |

⁷ Doctors pick a service code on the appointment/encounter. They don't see invoices. *Confirm:* some small clinics have doctors collect fees directly.

### 3.6 Telehealth

| Permission | PA | OO | OA | BM | DR | RC | PT |
|---|---|---|---|---|---|---|---|
| `video_session.create` | — | — | — | B | Own | B | — (auto-created on booking video visit) |
| `video_session.join` (token) | — | — | — | — | Own appointment | — | Own appointment |
| `video_session.end` | — | — | — | — | Own | — | — |
| `video_chat.read / send` | — | — | — | — | Own session | — | Own session |
| In-call chart view / Rx draft | — | — | — | — | Own (via EMR perms) | — | — |

Joining requires the time window `opens_at ≤ now ≤ closes_at` in addition to the permission.

### 3.7 Keeping the implementation small

The matrix is the specification. The code doesn't need one permission per row:
- **Group rows that grant to the same roles into one permission string.** For example, `appointment.create / reschedule / cancel / series` become `appointment.manage`, and `invoice.create / edit_draft / issue` plus `payment.record_manual` become `billing.front_desk`. Target: about 25 permission strings in `packages/shared/src/rbac.ts`.
- **Scopes reduce to three checks:** `O` (any branch), `B` (`resource.branch_id ∈ actor.branches(role)`), and `Own` (doctor = encounter/appointment doctor; patient = linked via `patient_accounts`).
- **UI:** one navigation menu per role, derived from the same map. No per-row UI toggles.

## 4. Role grant rules

| Grantor | May assign |
|---|---|
| PA | `org_owner` (initial owner invitation only) |
| OO | `org_admin`, and any branch role in any branch |
| OA | Any branch role in any branch. **Not** `org_admin` or `org_owner` |
| BM | `doctor`, `receptionist` in their own branches. **Not** `branch_manager` |
| Others | Nothing |

No one can grant a role to themselves, which blocks privilege escalation. `org_owner` changes only through `org.ownership.transfer`.

## 5. Enforcement points

| Layer | What is checked |
|---|---|
| Route guard | `@Require('<permission>')` and that the actor has **any** role granting it in this org. CI fails on any route without a declaration |
| Service | Scope (O/B/Own) against the loaded resource, for example `appointment.branch_id ∈ actor.branches(role)` or `encounter.doctor_id = actor.doctorId` |
| Database | Tenant (RLS) and authorship (composite FKs). Immutability triggers |
| UI | Hides unavailable actions. Never trusted |

## 6. Test plan for this matrix

- `packages/shared/src/rbac.ts` is the single machine-readable source. This document's tables are reviewed against it in PRs.
- Integration test generates one case per (role × permission × scope variant: own branch / other branch / other org) and asserts allow, 403 or 404.
- Specific negative tests: OO/OA without doctor role → `chart.read` and `soap_note.read` 403 (D3). RC → `soap_note.read` 403. PA → any `/orgs/:id/patients` 404. BM assigning `branch_manager` → 403. PT A → PT B's invoice 404.
- Decision tests:
  - **D2:** a doctor at Branch A reads the chart of a patient seen only at Branch B (allowed), and an audit row exists with actor, patient and action.
  - **D5:** portal responses never contain SOAP fields (schema snapshot test). Provisional diagnoses, draft prescriptions and unreleased labs are absent.
  - **D6/D19:** DR → `patient.verify` 403. RC → `patient.verify` 200. Portal registration response is byte-identical with and without a duplicate match. `mark-duplicate` only inactivates and changes no other record.
