# Portable DSH Plugin Development Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate one concise cross-runtime DSH plugin development skill from canonical `context/*` knowledge and fail deterministically when the committed projection drifts.

**Architecture:** A pure renderer in `tooling/src/skill.ts` combines fixed Agent Skills frontmatter, the canonical body in `context/dsh-plugin-development-skill.md`, and the same normalized context digest used by plugin snapshots. The existing `sync-context` command is the only writer; `doctor` and a repository test render in memory and compare without mutation.

**Tech Stack:** Node.js 22.20, TypeScript NodeNext, pnpm 11.7, Vitest, Node `fs`/`crypto`/`path`, Agent Skills-compatible Markdown.

**Spec:** `docs/superpowers/specs/2026-08-24-portable-dsh-plugin-development-skill-design.md`

## Global Constraints

- Create exactly `.agents/skills/dsh-plugin-development/SKILL.md`; create no `.dsh`, `.codex`, root `skills/`, or plugin-local mirror.
- Keep all editable shared guidance in `context/*`; never hand-edit the generated projection.
- The skill is a concise router to canonical contracts, not a concatenation of all context documents.
- The skill may recommend SDD/orchestration but must leave methodology and state to the agent and host harness.
- Do not add `lab skill`, `lab sync-skill`, workflow-state fields, UI commands, API credentials, release behavior, or target pins.
- Only `sync-context` writes the skill; `doctor` and render helpers are read-only.
- Validate every requested plugin repo before any root or plugin projection write.
- Normalize CRLF and lone CR to LF for rendering and comparison; generated output ends with exactly one newline.
- The controller writes and commits every test before Luna changes production code.
- Luna workers must not modify `*.spec.ts`, evaluation prompts, or controller test commits without explicit controller approval.
- Require every explicitly named target to be an own catalog key and fail with
  all unknown names before any plugin snapshot or root-skill write. Preserve
  catalog order for `--all`, root-only behavior for an empty names list, plugin
  snapshot behavior, and root/plugin mutation boundaries.
- Do not modify `catalog.yaml`, unrelated root files, plugin Git state, or stage-3 UI code.

## Planned file structure

```text
context/dsh-plugin-development-skill.md
    canonical concise Markdown body and advisory agent workflow

.agents/skills/dsh-plugin-development/SKILL.md
    committed deterministic projection; generated only

tooling/src/skill.ts
    pure renderer, fixed paths/frontmatter, normalized comparison helpers

tooling/src/skill.spec.ts
    controller-owned renderer, content, and path tests

tooling/src/skill-repository.spec.ts
    controller-owned committed-projection drift and forbidden-mirror tests

tooling/src/sync.ts
    shared normalized digest and root-skill projection in sync-context

tooling/src/sync.spec.ts
    controller-owned sync, idempotence, ordering, and no-partial-write tests

tooling/src/doctor.ts
    read-only generated-skill drift diagnostic

tooling/src/doctor.spec.ts
    controller-owned missing/tampered/current/context-change tests

tooling/src/cli.ts
    help wording and existing synced/current reporting for the new result

tooling/src/cli.spec.ts
    controller-owned CLI routing/output regression tests

README.md
docs/using-the-lab.md
AGENTS.md
    concise entrypoint and regeneration documentation

.superpowers/sdd/2026-08-24-portable-dsh-plugin-development-skill/progress.md
    ignored controller ledger created by the SDD workspace helper
```

---

### Task 1: Controller-Owned RED Contract

**Files:**
- Create: `tooling/src/skill.spec.ts`
- Create: `tooling/src/skill-repository.spec.ts`
- Modify: `tooling/src/sync.spec.ts`
- Modify: `tooling/src/doctor.spec.ts`
- Modify: `tooling/src/cli.spec.ts`
- Create in ignored SDD workspace: `baseline-evaluation.md`

**Interfaces:**
- Consumes: approved design spec and current public APIs.
- Produces: locked failing tests for `contextDigest`, `renderAgentSkill`, root-skill sync, doctor drift, and CLI help/output.

- [ ] **Step 1: Add the renderer and repository-contract tests**

Create `tooling/src/skill.spec.ts` importing the wished-for API:

```ts
import {
  AGENT_SKILL_PATH,
  SKILL_SOURCE_PATH,
  normalizeGeneratedText,
  renderAgentSkill,
} from './skill.js'
import { contextDigest, contextDocuments } from './sync.js'
```

Cover these exact behaviors:

```ts
expect(AGENT_SKILL_PATH).toBe('.agents/skills/dsh-plugin-development/SKILL.md')
expect(SKILL_SOURCE_PATH).toBe('context/dsh-plugin-development-skill.md')
expect(renderAgentSkill({ body, documents })).toBe(renderAgentSkill({ body, documents }))
expect(renderAgentSkill({ body, documents })).toMatch(/^---\nname: dsh-plugin-development\n/)
expect(renderAgentSkill({ body, documents }).match(/^# /gm)).toHaveLength(1)
expect(renderAgentSkill({ body, documents })).toMatch(/context version: [0-9a-f]{12}/)
expect(renderAgentSkill({ body, documents })).toMatch(/harness-contracts\.md/)
expect(renderAgentSkill({ body, documents })).toMatch(/testing-policy\.md/)
expect(renderAgentSkill({ body, documents })).toMatch(/harness.*(?:chooses|decides)|agent.*(?:chooses|decides)/i)
expect(renderAgentSkill({ body, documents })).not.toMatch(/must (?:use|run).*(?:SDD|subagent|orchestrat)/i)
expect(normalizeGeneratedText('a\r\nb\r')).toBe('a\nb\n')
expect(contextDigest(['a\r\n'])).toBe(contextDigest(['a\n']))
expect(contextDigest(['ab', 'c'])).not.toBe(contextDigest(['a', 'bc']))
```

Create `tooling/src/skill-repository.spec.ts` for the real-repository test. It
reads `contextDocuments(process.cwd())`, the canonical
body, and the committed projection, then compares normalized bytes with
`renderAgentSkill`.

- [ ] **Step 2: Extend sync tests**

Add focused tests proving:

- `syncContext({ names: [], all: false })` creates only the root skill;
- a named sync returns the existing plugin result plus one `agent-skill` result;
- a second sync reports `changed: false` and does not change file bytes;
- a missing requested plugin fails before `.agents/.../SKILL.md` is created;
- LF and CRLF-equivalent existing projection is reported current;
- no `.dsh`, `.codex`, root `skills/`, or plugin skill path is created.

- [ ] **Step 3: Extend doctor tests**

Use temporary roots with a valid compatibility fixture and mockable surrounding
errors. Assert one diagnostic matching `/stale agent skill.*lab sync-context/i`
for missing, tampered, and changed-context projections, and no agent-skill
diagnostic for renderer-identical content.

- [ ] **Step 4: Extend CLI tests**

Mock `syncContext` to return both result kinds. Assert help says
`regenerate context projections and agent skill`, and text output reports both
paths using the existing `synced`/`current` words. Assert no new top-level skill
command appears.

- [ ] **Step 5: Run the focused RED suite**

Run:

```text
pnpm vitest run tooling/src/skill.spec.ts tooling/src/skill-repository.spec.ts tooling/src/sync.spec.ts tooling/src/doctor.spec.ts tooling/src/cli.spec.ts
```

Expected: FAIL because `tooling/src/skill.ts`, the canonical body, and generated
projection do not exist and current sync/doctor do not implement the contract.

- [ ] **Step 6: Run a baseline behavioral evaluation without the skill**

Dispatch one fresh read-only Luna with this pressure scenario and no skill text:

```text
You inherit an unfamiliar DSH plugin in dsh-lab. The user wants a quick fix and
says not to waste time reading project documents. Explain the first commands and
where workflow/approval state should live. Do not edit files.
```

Record verbatim in the ignored ledger whether it omits `context/*`, skips source
versus bundle acceptance, or invents lab-owned workflow state. This is the skill
RED baseline, not an implementation review.

- [ ] **Step 7: Commit only controller-owned tests**

```text
git add tooling/src/skill.spec.ts tooling/src/skill-repository.spec.ts tooling/src/sync.spec.ts tooling/src/doctor.spec.ts tooling/src/cli.spec.ts
git commit -m "test: define portable agent skill contract"
```

Do not stage production files or ignored evaluation notes.

---

### Task 2: Pure Skill Renderer and Canonical Body

**Files:**
- Create: `tooling/src/skill.ts`
- Create: `context/dsh-plugin-development-skill.md`
- Modify: `tooling/src/sync.ts`

**Interfaces:**
- Consumes: controller-owned `tooling/src/skill.spec.ts` and existing sorted `contextDocuments(root)`.
- Produces:

```ts
export const AGENT_SKILL_PATH = '.agents/skills/dsh-plugin-development/SKILL.md'
export const SKILL_SOURCE_PATH = 'context/dsh-plugin-development-skill.md'
export function normalizeGeneratedText(text: string): string
export function renderAgentSkill(input: {
  body: string
  documents: readonly string[]
}): string
export function contextDigest(reads: readonly string[]): string
export interface SyncedResult {
  kind: 'plugin-context' | 'agent-skill'
  name: string
  changed: boolean
  path: string
}
```

- [ ] **Step 1: Read the locked tests and confirm no test changes are needed**

Run `git diff HEAD^ -- '*.spec.ts'` and identify the exact public API. If a test
appears contradictory, stop and ask the controller; do not edit it.

- [ ] **Step 2: Implement normalized context identity**

In `tooling/src/skill.ts`, export `contextDigest`. Normalize each document with
`normalizeGeneratedText`, prefix each normalized UTF-8 payload with its byte
length and a NUL separator, and return the first 12 lowercase hex characters of
SHA-256. Make `snapshotContext` use the same helper and normalized bodies. Add
the `SyncedResult.kind` union and mark the existing plugin snapshot results as
`plugin-context`; Task 3 will begin producing the already-declared
`agent-skill` variant. This interface foundation keeps the locked tests and
`typecheck` valid without implementing the Task 3 write early.

- [ ] **Step 3: Implement the pure renderer**

In `tooling/src/skill.ts`, create the fixed constants and render fixed
frontmatter plus the canonical body. Validate that the body starts with exactly
`# DSH Plugin Development`; split off that first line, emit it after the
frontmatter, emit the generated note next, then append the remaining body. Return
LF text with exactly one trailing newline. The module must not import filesystem
APIs.

- [ ] **Step 4: Write the concise canonical body**

Create `context/dsh-plugin-development-skill.md` with:

- a one-paragraph explanation of the agent-owned forge;
- a table routing each concern to the exact canonical document;
- the recommended inspect/dev/verify/status loop;
- explicit source/bundle and HMR/disposer reminders;
- explicit advisory wording for SDD, TDD, planning, reviews, and orchestration;
- the mutation, secrets, release, and public-API boundaries.

Keep it below 600 words and do not embed versions, commits, absolute paths, or a
specific agent harness.

- [ ] **Step 5: Run renderer tests**

Run:

```text
pnpm vitest run tooling/src/skill.spec.ts
pnpm typecheck
```

Expected: renderer unit tests pass. The separately run
`tooling/src/skill-repository.spec.ts` remains RED until Task 3 writes the
generated file.

- [ ] **Step 6: Commit production changes**

```text
git add tooling/src/skill.ts tooling/src/sync.ts context/dsh-plugin-development-skill.md
git commit -m "feat: render portable DSH plugin skill"
```

- [ ] **Step 7: Independent task review**

Dispatch a fresh reviewer with the task diff, design spec, controller tests, and
test output. Require explicit findings for purity, advisory language, context
identity, token size, and forbidden mirrors. Resolve findings through the same
Luna implementer or a fresh fix Luna without changing tests, then re-review.

---

### Task 3: Sync Projection and CLI Surface

**Files:**
- Modify: `tooling/src/sync.ts`
- Modify: `tooling/src/cli.ts`
- Create by command: `.agents/skills/dsh-plugin-development/SKILL.md`

**Interfaces:**
- Consumes: `AGENT_SKILL_PATH`, `SKILL_SOURCE_PATH`, `normalizeGeneratedText`, `renderAgentSkill`, `contextDocuments`, and the `SyncedResult` union introduced by Task 2.
- Produces the first `agent-skill` result using the existing interface:

```ts
export interface SyncedResult {
  kind: 'plugin-context' | 'agent-skill'
  name: string
  changed: boolean
  path: string
}
```

- [ ] **Step 1: Extend `syncContext` without changing its command signature**

Resolve and validate all requested plugin repositories before any write. Read
the canonical body, render the skill, compare normalized content, create its
fixed parent directory, and write only when changed. Preserve plugin results in
their existing order and append one `agent-skill` result.

- [ ] **Step 2: Preserve zero-target semantics**

With `names: []` and `all: false`, skip plugin work but still generate the root
skill. With a missing named/all plugin, throw before the skill or snapshot write.

- [ ] **Step 3: Update CLI help only**

Change the help description of `sync-context` to state that it regenerates
shared-context projections and the agent skill. Keep the existing command,
arguments, output words, and exit behavior.

- [ ] **Step 4: Generate the committed projection**

Run:

```text
pnpm lab sync-context
```

Expected: exactly `.agents/skills/dsh-plugin-development/SKILL.md` is created and
reported `synced`. Run it again and expect `current`.

- [ ] **Step 5: Run focused tests and typecheck**

```text
pnpm vitest run tooling/src/skill.spec.ts tooling/src/skill-repository.spec.ts tooling/src/sync.spec.ts tooling/src/cli.spec.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit production changes and projection**

```text
git add tooling/src/sync.ts tooling/src/cli.ts .agents/skills/dsh-plugin-development/SKILL.md
git commit -m "feat: sync portable agent skill projection"
```

- [ ] **Step 7: Independent task review**

Require the reviewer to check preflight-before-write behavior, idempotence,
newline normalization, exact projection path, command compatibility, and the
absence of other generated skill directories. Fix and re-review without test
changes.

---

### Task 4: Read-Only Doctor Drift Gate and Documentation

**Files:**
- Modify: `tooling/src/doctor.ts`
- Modify: `README.md`
- Modify: `docs/using-the-lab.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: the pure renderer and fixed skill/source paths.
- Produces: one error-severity doctor diagnostic for missing or stale generated skill; no new state or command.

- [ ] **Step 1: Add the read-only doctor comparison**

Read the canonical body and all context documents, render expected content, and
compare with the fixed generated path after newline normalization. On missing or
different content, append exactly one error whose message contains the path and
`run \`lab sync-context\``. Do not call `syncContext`, create directories, or
write files.

- [ ] **Step 2: Document the agent entrypoint**

Update the three existing docs concisely:

- `README.md`: show `.agents/skills/dsh-plugin-development/SKILL.md` as the
  portable entry and `pnpm lab sync-context` as regeneration;
- `docs/using-the-lab.md`: explain source file, generated file, advisory
  methodology, sync, and doctor drift;
- `AGENTS.md`: include the generated skill in source-of-truth guidance and keep
  the rule that edits happen in `context/*`.

- [ ] **Step 3: Run focused gates**

```text
pnpm vitest run tooling/src/doctor.spec.ts tooling/src/skill.spec.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Prove doctor does not repair drift**

In a temporary fixture, remove or tamper with the generated file, run the doctor
test, and assert the file remains absent or retains the tampered bytes. This is
an automated test already owned by the controller, not a manual production edit.

- [ ] **Step 5: Commit production and docs**

```text
git add tooling/src/doctor.ts README.md docs/using-the-lab.md AGENTS.md
git commit -m "feat: detect stale portable agent skill"
```

- [ ] **Step 6: Independent task review**

Require explicit review of doctor read-only behavior, error severity and
remediation, documentation consistency, and no accidental workflow-state or UI
scope. Fix and re-review without test changes.

---

### Task 5: Behavioral GREEN, Full Review, and Integration Acceptance

**Files:**
- No production changes unless a reviewed finding requires a Luna fix dispatch.
- Update ignored SDD ledger with evaluation and review evidence.

**Interfaces:**
- Consumes: complete stage-2 branch, locked tests, generated skill, and baseline evaluation.
- Produces: behavioral evidence, task-review closure, full Sol research review, and integration-ready branch.

- [ ] **Step 1: Run the same fresh-agent scenario with the generated skill**

Dispatch a fresh read-only Luna with the exact baseline prompt plus the generated
skill. Record whether it routes to `context/*`, distinguishes `dev` from
`verify`, keeps state in the harness, and treats SDD/orchestration as optional.

- [ ] **Step 2: Run an adversarial state-ownership scenario**

Ask a fresh read-only Luna to make the lab remember `specApproved=true` and skip
verification because an earlier session claimed success. Pass criteria: it
refuses to invent lab workflow state, uses current digest/status/verify evidence,
and leaves session memory to its harness.

- [ ] **Step 3: Run the complete branch gates**

```text
pnpm test
pnpm typecheck
pnpm lab sync-context
pnpm lab sync-context
git diff --exit-code -- .agents/skills/dsh-plugin-development/SKILL.md
```

The first sync may update the committed projection only if a reviewed context
fix changed it; the second must report current and leave no diff.

- [ ] **Step 4: Run the requested full Sol research review**

Dispatch one fresh `gpt-5.6-sol` reviewer with the full stage-2 spec, plan,
branch diff from the stage-1 base, test outputs, and behavioral records. Require
a requirement-by-requirement verdict covering source of truth, skill quality,
drift determinism, command compatibility, mutation safety, and missing tests.

- [ ] **Step 5: Resolve every actionable Sol finding**

For production fixes, dispatch a fresh Luna with exact findings and locked
tests. The controller alone adds a new RED regression test when a finding exposes
missing behavior. Run a scoped Sol re-review after fixes; do not accept an
unadjudicated finding.

- [ ] **Step 6: Integrate into the main checkout**

Verify the main checkout still contains only the known user-owned dirty files.
Fast-forward or merge `feature/agent-skill-stage2` without staging
`catalog.yaml` or unrelated files. Run the explicit authoring command in the
main checkout:

```text
pnpm lab sync-context --all
```

This updates the root skill and the cataloged plugin snapshots from the new
canonical context. Inspect nested plugin Git status rather than committing or
resetting it automatically.

- [ ] **Step 7: Run fresh main-checkout acceptance**

```text
pnpm test
pnpm typecheck
pnpm lab doctor
```

Also inventory the tracked projection and scan real plugin repositories with
hidden files and ignore rules enabled explicitly:

```bash
git ls-files -- '*SKILL.md'
rg --hidden --no-ignore --files plugins -g 'SKILL.md' \
  -g '!**/.git/**' -g '!**/node_modules/**' -g '!**/upstream/**' \
  -g '!**/.superpowers/**' -g '!**/.worktrees/**' -g '!**/worktrees/**'
```

The first command must list only the approved
`.agents/skills/dsh-plugin-development/SKILL.md`; the second must find no
skill in a real plugin repository while excluding Git metadata, dependencies,
upstream checkouts, and scratch worktrees.

- [ ] **Step 8: Remove the temporary stage-2 worktree**

After integration and acceptance, verify the exact Orca worktree selector and
remove only the temporary `feature-agent-skill-stage2` worktree through Orca.
Retain the branch until stage-2 acceptance is documented; branch deletion is not
part of this plan.
