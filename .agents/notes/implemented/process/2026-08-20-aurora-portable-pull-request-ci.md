# Agent Note: Aurora portable pull-request CI

Status: implemented

English | [中文](2026-08-20-aurora-portable-pull-request-ci.zh.md)

## Problem

The public DSH workflow contains runner labels owned by the upstream organization. Aurora does not have those pools, so required pull-request jobs can remain queued until they are cancelled even when the repository code and standard-hosted checks are healthy.

## Decision

The required `node-24`, `node-24-coverage`, and `node-24-consumers` jobs in [ci.yml](../../../../.github/workflows/ci.yml) use `ubuntu-latest` by default. `DSH_CI_FAILOVER_LINUX` remains an explicit opt-in to the in-house Linux standby pool, and standard-hosted concurrency stays conservative. The independent `windows-native` job uses `windows-2025` by default and retains `DSH_CI_FAILOVER_WINDOWS` for the Windows standby pool. It remains outside `all-checks-passed.needs`, so native Windows evidence does not delay the required verdict.

Manual runner benchmarks and push-only self-hosted standby drills retain their dedicated labels because they are diagnostic or non-blocking workflows, not required pull-request execution.

## Alternatives considered

**Keep the inherited DSH runner labels.** Aurora cannot allocate those labels, so required jobs remain pending and the aggregate cannot produce a verdict.

**Remove native Windows pull-request coverage.** This would hide native-kernel evidence instead of making it portable; the independent standard Windows job preserves that signal.

**Make native Windows part of the required aggregate.** Standard Windows capacity is slower and less predictable than the Wine blocking path, so it remains an independent check.

## Consequences

Required pull requests can execute with GitHub-hosted capacity available to Aurora. The standard Linux jobs use less parallelism than the upstream enterprise topology and may take longer. An account-level GitHub Actions billing or spending-limit failure can still prevent standard-hosted jobs from starting; that external condition is reported separately from runner-label availability.
