# Review Severity and Boundary Protocol

Shared contract for automated and human reviews in this repository. Review
prompts reference this file; findings must follow its severity ladder,
blocking semantics, and scope boundaries. The goal is convergence: each
round of review should move a change closer to merge, not open an unbounded
frontier.

## Review dimensions

Every full review covers these dimensions; each finding names the dimension
it belongs to and takes its severity from the ladder below.

1. **Correctness & regressions** — does the change do what it claims, on
   the mainline paths, without breaking existing behavior?
2. **Contracts & compatibility** — versioned wire/data contracts evolve
   additively or with an explicit version bump (session formats, RPC
   shapes, `Config` schemas, cordis event maps); changed shapes update
   every consumer (search for them); migrations and rollback stay
   possible.
3. **Tests** — new behavior is pinned by tests at the right level; changed
   behavior updates the tests that encoded the old behavior. This
   repository's testing policy (`docs/testing.md`) requires keyless
   snapshots through real runnable examples for non-trivial behavior
   changes; package tests alone do not substitute for the assembled
   application transcript.
4. **Security** — within the threat-model boundary defined below.
5. **Complexity** — the audit defined below.
6. **Architecture consistency** — the change follows the repository's
   governance patterns rather than inventing parallel ones. In this
   repository that includes: plugins over loop changes (new behavior goes
   on the documented extension seams; changing `agent-loop` requires
   updating `docs/architecture.md`); registrations are effects
   (`ctx.effect()`/`ctx.on()`, a registry's `register()` returns the
   disposer); model-visible ⟺ logged (anything reaching a model request is
   reconstructable from the session log); misconfiguration fails loud at
   the earliest resolvable point; capability seams are the three-package
   interface/implementation/consumer split. Violations are P1.
7. **Documentation sync** — user-visible behavior changes update the
   affected docs; bilingual pairs stay consistent (README/Agent Note
   `.md` ↔ `.zh.md`, enforced by `pnpm run verify-translation-pairing`),
   and the Agent Note rule applies: non-trivial changes include an Agent
   Note in the same PR (`.agents/notes/`).

Style and formatting are machine-gate territory (oxlint, tsc, prettier via
eslint, doc gates), not review findings, unless the gates cannot express
the rule.

## Severity ladder

| Level | Definition | Blocking? |
|-------|------------|-----------|
| P0 | Breaks correctness, loses data, or defeats a security guarantee on a mainline path (default configuration, shipped scenarios/fixtures, documented workflows). | Yes |
| P1 | Real defect or regression reachable under specific but plausible conditions; includes broken contracts between components and races with observable consequences. | Yes |
| P2 | Hardening beyond the declared threat model, edge cases reachable only with synthetic data not present in any repository fixture, performance concerns without a demonstrated pathology. | No |
| P3 | Style, naming, readability, documentation polish. | No |

Blocking means "should change before merge". P2/P3 findings must be listed
separately under a "Follow-up suggestions" heading and must not be counted
toward an approve/reject verdict. A review whose only findings are P2/P3
concludes: "No blocking issues; N follow-up suggestions."

## Default threat-model boundary

Unless a change explicitly claims a stronger guarantee in its own
documentation, reviews assume:

- The local developer environment is semi-trusted: user-writable caches,
  home-directory configuration, git configuration, and PATH are not
  defended against an attacker who can already write to them. Defenses
  against such attackers are P2 hardening, not blocking findings.
- Supply-chain integrity is anchored at pinned digests/lockfiles. Attacks
  requiring compromise of the pinning mechanism itself are out of scope.
- Denial-of-service by the machine owner against their own tooling is out
  of scope.
- For the Web GUI and desktop shell specifically: the local HTTP server
  binds loopback by default; the /api browser-trust fence (Host header,
  loopback, declared `trustedHosts`) is the authority on request trust.
  Cross-origin, DNS-rebinding, and confused-deputy attacks against that
  fence are in scope; attacks requiring local code execution first are
  out of scope.

When a finding sits outside this boundary, report it once as P2 with a note
that it exceeds the default threat model, and suggest recording it under
"Accepted residual risks" below rather than re-raising it.

## Complexity audit

Every review includes a complexity audit of the changes: new functionality
must earn its structure. Check, in order:

1. **Reuse before reimplementation.** Does the change reimplement something
   the repository already provides (helpers, DTOs, validation layers,
   rendering paths, test utilities)? Search for existing equivalents before
   concluding. Duplicating a maintained implementation splits future
   maintenance and is a P1 finding.
2. **Speculative abstraction (YAGNI).** Does a new abstraction (class,
   layer, configuration knob, DTO field, feature flag, extension point)
   have at least a second user or a concrete, named near-term consumer? If
   not, flag it as P2 with the simpler inline alternative.
3. **Mechanism minimization.** Could the same behavior be expressed with
   less machinery — fewer layers, fewer states, merged near-duplicate
   functions, a plain function instead of a class, data instead of code?
   Report as P2/P3 with the concrete simplification.
4. **Defensive code at internal boundaries.** Validation or fallback logic
   for inputs that cannot occur (values produced and consumed inside the
   same trusted codebase) is noise; flag as P3. Validation at system
   boundaries (user input, external files, network payloads) is correct
   and must not be flagged.

Severity mapping: duplicated maintained functionality is P1 (blocking);
unused abstractions and reducible mechanisms are P2; readability-level
simplifications and internal-boundary defensiveness are P3. The audit's
purpose is convergence toward the smallest change that does the job, not
style enforcement.

## Depth-probing rule

When reviewing a defense or validation mechanism, evaluate its **complete
boundary in one round**: state what the mechanism does defend, the next
layer of attack it does not, and where the sensible stopping point is given
the threat model above. Do not return one layer deeper on each successive
review round; that pattern produces unbounded review cycles on a frontier
that was already knowingly accepted.

## Risk-tiered review depth

Review effort scales with the blast radius of the touched paths, judged by
what consumes them (agent-loop, session, and LLM code is consumed by
everything; examples and docs are leaves):

| Tier | Typical paths | Depth |
|------|---------------|-------|
| High | `packages/core/`, `packages/agent/`, `packages/agent-loop/`, `packages/llm/`, `packages/session-persistence/`, `vendor/cordis`, wire contracts and RPC schemas, `apps/cli/` launcher logic | All dimensions, line-level scrutiny, cross-consumer impact search |
| Medium | `apps/web/`, `apps/desktop/`, `packages/client/`, `packages/ui/`, test infrastructure, `scripts/` gates | Correctness, contracts, complexity; edge cases at P2 |
| Low | `docs/`, `website/`, comments, non-executable assets | Accuracy and doc-sync only |

A PR mixing tiers is reviewed at the depth of its highest tier, but
findings in lower-tier files still use lower-tier expectations.

## Convergence protocol for repeated reviews

Before reviewing, read the pull request's existing review comments and the
author's responses (provided as context by the workflow when available):

1. Do not re-raise a finding that was reported and fixed, reported and
   answered with an accepted-risk rationale, or recorded below.
2. Focus on commits pushed since the last review round; the accumulated
   diff is context, not the primary search space.
3. New findings in previously reviewed code are allowed but must meet the
   P0/P1 bar to block.

**Round budget.** Round 1-2 on a pull request run all dimensions at full
depth. From round 3 onward, new findings are reportable only at P0/P1;
everything else is limited to verifying fixes for previously reported
findings. If round 3+ keeps producing new P0/P1 findings, say explicitly
that the change may need redesign or splitting rather than another patch
round.

## Finding lifecycle and arbitration

Each finding follows one path, and reviews track it across rounds:

```
reported -> fixed                      (verify, then closed)
         -> accepted as residual risk  (recorded below, then closed)
         -> rebutted by the author     (one counter allowed, see below)
```

If the author rebuts a finding with a rationale, the reviewer may respond
**once** with new evidence (not a restatement). After that, the finding is
decided by the maintainer: either it is fixed, or it is recorded under
"Accepted residual risks" / "Lessons" and closed. Reviews never re-argue a
closed finding. The maintainer is the final arbiter; automated reviewers
advise.

## Gate feedback discipline

When a review finds a *mechanical* defect class — one a linter, type
checker, formatter, or contract test could have caught (shape mismatches,
unused symbols, missed call-site updates, format drift) — the finding
should include a one-line suggestion for the gate that would catch the
class, not just the instance. This repository's gates include
`pnpm run typecheck`, `pnpm run lint`, `pnpm run test:coverage`, `pnpm run
doc-sync`, and `pnpm run hygiene`; recurring mechanical classes belong in
these machine gates. Review attention belongs on judgment problems.
Maintainers record adopted gate rules in the Lessons appendix so the
origin stays traceable.

## Accepted residual risks

Maintainers record knowingly accepted risks here so reviews stop re-raising
them. Each entry: scope, risk, rationale, date. (None recorded yet.)

## Lessons

Process improvements distilled from review rounds: recurring finding
patterns, gate rules adopted from review findings, and escaped defects
(bugs that reached the default branch despite review) with the review
blind spot they exposed. Each entry: pattern, upstream fix, date. (None
recorded yet.)
