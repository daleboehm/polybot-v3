# v1/v2 Artifacts Archive

> **Status**: ARCHIVED for historical reference. These are documents, reports,
> and planning artifacts from the March–April 2026 v1/v2 era. They predate the
> v3 rebuild and are kept here ONLY so the history isn't lost when the parent
> `Polymarket/` directory on OneDrive gets cleaned up.

## Contents overview

**Reports & audits** (v1/v2 era):
- `VPS_AUDIT_EXECUTIVE_SUMMARY.txt`, `VPS_COMPREHENSIVE_AUDIT_20260330.md`, `VPS_DIAGNOSTICS_2026-03-31.md`
- `AUDIT_INDEX_20260330.txt`, `FINAL_REPORT.txt`, `DELIVERABLES.txt`, `DELIVERABLES_SUMMARY.txt`
- `INDEX_20260330.md`, `DEPLOYMENT_SUMMARY.md`, `DEPLOYMENT_VERIFICATION.txt`
- `POLYMARKET_SYSTEM_STATUS_20260330.md`, `system_status_2026-03-30.md`, `system_status_2026-03-31.md`, `system-status-report-2026-03-31.pdf`

**Systems & architecture docs**:
- `SYSTEMS_1_2_INDEX.txt`, `SYSTEMS_2_DEPLOYMENT_SUMMARY.txt`, `SYSTEMS_DEPLOYED.md`, `SYSTEMS_QUICK_START.md`
- `ATTRIBUTION_ENGINE.md`, `ATTRIBUTION_QUICK_REFERENCE.txt`, `README_ATTRIBUTION_ENGINE.md`, `README_THREE_SYSTEMS.md`
- `AUTO_OPS_DEPLOYMENT_SUMMARY.md`, `AUTO_OPS_OPERATIONS_GUIDE.md`, `AUTO_OPS_QUICK_REFERENCE.txt`, `AUTO_OPS_TECHNICAL_SPEC.md`
- `ORCHESTRATOR_TRADE_LOGGER_DEPLOYMENT.md`, `RISK_MANAGER_DEPLOYMENT.md`, `DISCORD_DEPLOYMENT_SUMMARY.md`, `discord_setup_guide.md`
- `REALLOCATION-SUMMARY.txt`, `config-reallocation-2026-03-30.md`

**Planning & strategy**:
- `gemini-capital-implementation-plan-2026-04-01.docx`, `gemini-capital-project-plan-2026-04-01.docx`
- `sprint_to_500_playbook.md`, `wallet-strategy-analysis-2026-04-03.html`
- `before-after-comparison.txt`, `ENTITY2_ACTIVATION_QUICK_REFERENCE.md`
- `QUICK_START.txt`, `Gemini Capital - Master Dashboard.pdf`
- `SKILL.md` — the Polymarket skill definition for Claude

## What's NOT in this archive

The **code** from the v1/v2 era was deleted, not archived:
- `scripts/` (254 Python files) — v1/v2 trader + patch scripts
- `fixes/` — v2 fix scripts
- `dashboard/`, `github-pages/`, `vps-dashboard/` — old Python/HTML dashboards
- `redeem/`, `lifecycle/` — replaced by `src/execution/neg-risk-redeemer.ts` and `src/market/paper-resolver.ts`
- Top-level `.py` / `.jsx` / `.sh` files — replaced by v3 TypeScript

Dale's directive (2026-04-10): "v1 should not even exist." Per the rebuild plan
R3c cleanup gate, dead code gets deleted; documentation gets preserved for
history. This archive is the doc side of that split.

## Deletion schedule

Per the rebuild plan, this entire directory can be deleted after 60 days of
v3 running clean (approximately 2026-06-10). Add a reminder to `docs/todo.md`.
