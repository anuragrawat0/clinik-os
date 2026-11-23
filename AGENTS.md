## Permissions (hard limits — violating any of these = task failed)
- Local only. You MAY: read files, edit files in the stated scope, run local commands (pnpm, tests, docker compose -p clinik-smoke).
- You MUST NOT: git push, git commit --amend on shared history, open/close/edit PRs or issues, run any gh command that writes, change GitHub settings/secrets, or touch any remote.
- Commit only if the prompt explicitly says "commit"; otherwise leave changes uncommitted. Never commit docs/ or AGENTS.md.
- No package installs or dependency changes unless the prompt names the package.
- No destructive commands outside clinik-smoke: no `docker compose down -v` on clinik-os, no `git reset --hard`, `git clean`, branch deletion, or force operations.
- If a step seems to need any of the above: stop and ask. The owner does push/PR/merge.
# AGENTS.md

## 1. Project Context

Before making changes, read:

- docs/PROJECT_CONTEXT.md
- docs/ARCHITECTURE.md
- docs/DATABASE_DESIGN.md
- docs/RBAC_MATRIX.md
- docs/DEVELOPMENT_ROADMAP.md

These documents define the approved project requirements and architecture.

## 2. Technology Stack

- Frontend: Next.js + TypeScript
- Backend: NestJS
- Database: PostgreSQL
- ORM: Drizzle
- Background jobs: pg-boss
- Video: Daily
- Payments: Stripe test mode
- Development: Docker Compose

Do not introduce additional infrastructure without approval.

## 3. Architecture Rules

- Follow the modular monolith architecture.
- Keep frontend and backend responsibilities separate.
- Follow existing module boundaries.
- Do not introduce microservices.
- Do not introduce Redis into the MVP.
- Use PostgreSQL for persistent data.
- Follow the approved database schema.

## 4. Multi-Tenant Security

- Every tenant-owned operation must enforce organization isolation.
- Never trust organization IDs supplied by users without authorization checks.
- Follow the approved RBAC matrix.
- Never bypass PostgreSQL RLS.
- Use transaction-local tenant context.
- Test cross-tenant access restrictions.

## 5. Medical Data Security

- Use synthetic patient data during development.
- Never expose sensitive medical records to unauthorized roles.
- Signed clinical records must not be silently modified.
- Audit sensitive clinical record access.
- Do not implement autonomous medical diagnosis or prescribing.

## 5a. v1.2 baseline — do not reintroduce
The approved baseline is v1.2 (decisions in docs/ARCHITECTURE.md §11). Do NOT add:
- tax/GST columns or logic (D11r)
- tenant_counters or gapless numbering — use plain sequences, gaps allowed (D20)
- patient_duplicate_candidates or automatic relinking/merging (D19)
- an in-app Synthea upload, import API, import_jobs table or import worker — use `pnpm seed:synthea` (D18)
- worker jobs other than reminders, or worker grants beyond DATABASE_DESIGN §11.3 (D22)
- idempotency on routes other than booking and checkout (D23); Stripe event dedupe stays
- triggers beyond R1–R6 + set_updated_at; other rules are service checks with tests (D21)
- Redis, microservices, extra infrastructure (D12)
Keep all seven roles, RLS, composite FKs, the double-booking EXCLUDE constraints and audited clinical reads.

## 5b. Database rules
- Never edit a migration that has been merged or applied; add a new forward migration. Every migration has a working down.
- Every new tenant table: `organization_id NOT NULL`, `UNIQUE (organization_id, id)`, composite FKs to tenant parents,
  RLS ENABLE + FORCE with the tenant_isolation policy, and set_updated_at if it has updated_at.
- Runtime roles (clinic_app, clinic_worker) never own tables and never have BYPASSRLS. clinic_migrator is migrations only.
- Tenant context only via transaction-local set_config(..., true); job code only through runInTenant.

## 5c. Milestone scope and status
- Work only on the current milestone in docs/DEVELOPMENT_ROADMAP.md (currently M1b). Don't start later milestones.
- After a milestone slice, update the roadmap "Implementation status" using only:
  Verified (check executed and passed this session) / Implemented-unverified / Partial / Missing.
- If code conflicts with v1.2, list it under Discrepancies; don't silently change docs or code to match.

## 6. Coding Conventions

- Use TypeScript.
- Prefer explicit types.
- Keep functions and modules focused.
- Reuse existing services and components.
- Validate API inputs.
- Handle errors explicitly.
- Avoid unnecessary dependencies.
- Follow existing naming conventions.

## 7. Development Workflow

Before implementing a feature:

1. Read the relevant architecture documentation.
2. Inspect existing related modules.
3. Identify database and API dependencies.
4. Implement in the appropriate module.
5. Add or update tests.
6. Run relevant checks.
7. Report files changed and test results.

## 8. Architecture Changes

Do not silently change approved architectural decisions.

If a change is necessary:

1. Explain the problem.
2. Describe the proposed change.
3. Explain its impact on other modules.
4. Propose an architecture decision record (ADR).
5. Wait for approval before changing the architecture.

## 9. Testing Requirements

- Test important business logic.
- Test role-based permissions.
- Test tenant isolation.
- Test database constraints.
- Test appointment concurrency.
- Test payment webhook security.
- Never claim tests passed unless they were actually executed.

Use the commands defined in package.json and the project documentation.

## 10. Git Rules

- Do not overwrite unrelated changes.
- Do not commit secrets or environment files.
- Keep changes focused on the assigned task.
- Do not modify unrelated modules.

## Docker hygiene
- Disposable Compose runs use the fixed project name `clinik-smoke` (never a new unique name) and must not touch `clinik-os`.
- Always finish with `docker compose -p clinik-smoke down -v --rmi local`.
- Don't create additional Compose projects or images without reason. Testcontainers cleans itself up.

## Local verification (memory limit)
- Run locally: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm boundary:check`, `pnpm build`, `pnpm test`.
- Do NOT run compose-smoke, `docker compose build`, or any second Compose stack locally.
  compose-smoke runs in GitHub Actions on every push to the PR branch.
- To check CI: `gh pr checks --watch` (or the Actions tab). Paste the result.
- Do not stop or modify the user's `clinik-os` stack.

