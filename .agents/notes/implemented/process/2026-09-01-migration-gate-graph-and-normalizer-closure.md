# Agent Note: closing the baseline-migration gate graph and snapshot normalizer

Status: implemented

English | [中文](2026-09-01-migration-gate-graph-and-normalizer-closure.zh.md)

## Problem

Adopting the public DSH baseline moved Aurora's product shells onto a new package graph, and four required checks failed afterwards for reasons the migration itself introduced.

The merge-forward kept `apps/desktop`'s call to `requireWebLaunchPipes` while taking the newer launcher, which had deleted that function in favor of a `WebLaunchChild` return type whose `stdout` and `stderr` are declared non-null. The desktop `tsc` failed on the missing name, which failed the `product-artifacts` gate, which meant nothing built `apps/vscode/dist/`; the VS Code sidebar snapshot, the production-CSP webview boot, and the built-entry smoke then failed on a missing bundle. The same deleted narrowing left `stdout` and `stderr` typed as `error` in `main.ts`, producing seven of nine lint errors.

Folding `apps/web/tests/scaffold.ts`'s ARIA normalizer into the shared `apps/test-support/snapshot.ts` dropped two rules. The duration pattern lost the optional space in `\d+m ?\d+s`, so the stats line's compact `3860m53s` spelling stopped collapsing while the message-chrome `2m 42s` spelling still did; the compaction-token rule disappeared entirely although the committed goldens still expect `{{tokens}}`. Five web e2e goldens failed on volatility the goldens were written to exclude.

Two failures were older than the shell migration. `ciWindowsObservationalGates` carried the VS Code built-entry smoke with no `product-artifacts` gate in the same aggregate, so the required Windows job asserted against a bundle no gate in that lane produces. And the headless keep-alive test gave the adapter a 150 ms idle budget against 60 ms SSE comments: a 90 ms margin that a shared runner exceeds, expiring the watchdog, which the default retry policy repeats — observed as the two requests where the test expects one.

## Decision

`apps/desktop` destructures `stdout` and `stderr` straight from the child that `spawnWebLaunch` returns. The fixed stdio tuple is a type-level guarantee, so a runtime re-check would be validation at a typed same-process boundary.

The shared normalizer restores both lost rules with the comments that state why each exists. One normalizer serves the Web and VS Code lanes, so a rule missing from it is missing from every golden that lane owns.

`builtTreeConsumerGates` owns the gates that read a `build` gate's output tree, and every aggregate owning a plain `build` appends it. This removes the clone that `jscpd` reported and makes the Windows hole unrepresentable: no aggregate can carry the built-entry smoke without the artifact gate that produces its bundle. A graph-wide test asserts that relationship across all modes rather than a fixed list, so a new mode inherits the check.

The keep-alive fixture derives its idle budget from the interval it publishes: comments every 250 ms against a 500 ms budget. The budget still has to exceed one interval and stay under three, so a build that drops comment handling still idles out and still retries — the contract the test owns is unchanged, and only the margin against runner scheduling grew. The fixture reads the budget from the environment the test sets, so the two numbers have one home.

`PostMessageApiClient` reads its `terminal` and `cleanupRequested` flags through functions. Both are mutated by the listener closure, which a synchronous embedder can drive while `onMessage` is still installing; static narrowing does not model that call and reported the direct reads as always-falsy. This is the pattern `waitForHttpOk` already uses for its abort flag.

## Alternatives considered

**Restore `requireWebLaunchPipes`.** It would compile, but the launcher deliberately replaced a runtime pipe check with a type that cannot be constructed without both pipes. Reintroducing it re-adds validation the static interface already guarantees.

**Re-record the failing web goldens.** The goldens are correct; the normalizer regressed. Recording would bake a machine's measured durations and one worktree's path lengths into committed expectations, and the next run on another host would fail again.

**Mark the headless keep-alive test flaky, or drop its retry assertion.** The request count is how the test observes that comments reset the watchdog. Removing it deletes the contract; quarantining it hides a real provider-transport behavior. Widening both sides keeps the assertion and removes only the runner sensitivity.

**Give the Windows aggregate its own `product-artifacts` entry.** It fixes this lane and leaves the next aggregate free to make the same mistake. Binding producer and consumer in one helper, with a test over every mode, fixes the class.

**Suppress the two always-falsy lint errors inline.** A disable comment would assert the rule is wrong. The rule is right about what it can see; the function read tells the compiler what the closure actually does, and matches existing repository practice.

## Consequences

Desktop and VS Code build from a clean tree, so the artifact gate produces `apps/vscode/dist/` and its three dependent suites run against a real bundle instead of failing on absence. Lint reports no errors, `jscpd` finds no clones, and `webview-bridge.ts` and `web-launcher/src/index.ts` reach per-file 100%.

The added tests are the parse boundary and the paths a hostile or reentrant embedder reaches: every malformed-request and malformed-response rejection with and without a correlatable id, protocol-version match and mismatch, a malformed message that fails its owning call while an uncorrelatable or foreign-id one is ignored, and a readiness poll whose single attempt consumes the whole deadline. One unreachable line remains — `cleanup`'s idempotence guard, whose every caller already returns early when terminal — annotated with why nothing reaches it twice.

`streamIdleTimeoutMs` in the keep-alive fixture is now supplied by the launching test. A run of that fixture outside the test observes the adapter's positive-finite validation failing at load rather than a silent default, which is the intended loud failure for a missing referent.

The gate-graph test iterates every mode, so adding a mode that carries the built-entry smoke without the artifact gate fails at that test rather than in a required Windows job.
