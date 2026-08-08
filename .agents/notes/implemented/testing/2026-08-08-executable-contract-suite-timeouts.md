# Agent Note: Suite-wide timeouts for real-executable contract tests

Status: implemented

English | [中文](2026-08-08-executable-contract-suite-timeouts.zh.md)

## Problem

`scripts/oxlint-contract.spec.ts` asserts the Oxlint executable's real behavior: each case writes a probe file, spawns the actual `oxlint` binary against a config that nulls out `ignorePatterns`, and asserts on its diagnostics. Nulling the ignore list is required — the repository config ignores `**/oxlint-contract-*`, so a probe would otherwise be skipped — and it makes every case build a type-aware program over the whole workspace.

That work is slow and, more importantly, wildly variable in duration. The same invocation, asserting the same thing, was measured between 13s and 49s on one developer host while CI reported 1.5s to 6.5s for the same cases. Vitest's default 5s timeout therefore fails by host speed and load rather than by product behavior, and the failure is indistinguishable from a real regression in the report.

Three of the file's six cases carried an individual `20_000` timeout; the other three sat on the default. This is the shape that hides the problem: `reports an unused suppression` failed in CI at the 5s default while its siblings passed, which reads as one flaky case rather than a file-wide budget that was never set. Raising only that case then moved the failure to two others — including one already at `20_000` — because running all six concurrently raises contention for every case.

## Decision

The timeout is a property of this suite, declared once on its `describe`:

```ts ignore-check
describe('Oxlint executable contract', { timeout: 90_000 }, () => {
```

The three per-case `20_000` values are removed; the suite budget covers every case, including cases added later. Placing it on the suite rather than per case is the point: a new case cannot silently inherit the 5s default, which is exactly how the failing case arose.

The budget is sized to the worst observed run, not the median. A timeout that covers the median converts host variance into intermittent red, which costs more review attention than a generous ceiling costs wall-clock — a case that passes never waits for its deadline, so the ceiling is only paid on genuine hangs.

This applies to suites that spawn a real executable over the workspace. It is not a licence to raise timeouts generally: a slow in-process test is a test to fix, and a hang that a 90s ceiling merely delays is still a defect.

## Alternatives considered

**Keep per-case timeouts and add the missing ones.** Tried first, and it failed: raising the one reported case moved the failure to two siblings, one already at `20_000`. Per-case values also have to be re-audited whenever a case is added, and the file had already drifted into a mixed state where half the cases were unprotected.

**Make the probe cheaper so the default 5s suffices.** The cost is the workspace-wide type-aware program, which is the thing under test — a contract test for project discovery cannot narrow its program without narrowing its assertion. Restricting the config's `ignorePatterns` to a subtree was measured and made the run *slower*, not faster.

**Mark the suite as flaky and retry it.** Retries would hide the signal rather than fix it: nothing here is nondeterministic, and a retried 49s suite costs more than a single run under a correct ceiling.

**Exclude the suite from the coverage gate.** It is already coverage-exempt (`scripts/coverage-exempt.ts`); exemption controls instrumentation, not timeouts, so the aggregate still runs it plain and the failure would remain.

## Consequences

The file's timing contract lives in one place and new cases inherit it. A genuine hang in this suite now takes up to 90s per case to surface instead of 5s, accepted because the alternative is intermittent failures that cost more to triage than the delay costs to wait.

The measurements behind the budget are host-specific and are recorded in the source comment as observed ranges rather than as a rule to derive new budgets from. Other suites keep their own timeouts; this note does not set a repository-wide default, and the 90s figure is not a precedent to copy without measuring the suite in question.
