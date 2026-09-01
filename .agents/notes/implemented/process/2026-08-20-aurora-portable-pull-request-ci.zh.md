# Agent Note: Aurora portable pull-request CI

Status: implemented

[English](2026-08-20-aurora-portable-pull-request-ci.md) | 中文

## 问题

公开 DSH 工作流包含由上游组织拥有的运行器标签。Aurora 没有这些运行器池，因此必需的拉取请求作业可能一直排队到被取消，即使代码和标准托管检查本身是健康的。

## 决策

[ci.yml](../../../../.github/workflows/ci.yml) 中必需的 `node-24`、`node-24-coverage` 和 `node-24-consumers` 作业默认使用 `ubuntu-latest`。`DSH_CI_FAILOVER_LINUX` 仍可显式选择内部 Linux standby 运行器池，标准托管运行器使用保守的并发上限。独立的 `windows-native` 作业默认使用 `windows-2025`，并保留 `DSH_CI_FAILOVER_WINDOWS` 以选择 Windows standby 运行器池。该作业继续排除在 `all-checks-passed.needs` 之外，因此原生 Windows 证据不会延迟必需判定。

手动运行器基准测试和只在推送时运行的 self-hosted standby 演练仍保留专用标签，因为它们是诊断性或非阻断工作流，不是必需的拉取请求执行路径。

## 曾考虑的替代方案

**保留继承的 DSH 运行器标签。** Aurora 无法分配这些标签，必需作业会持续等待，聚合流程无法产出判定。

**移除拉取请求中的原生 Windows 覆盖。** 这会隐藏原生内核证据，而不是使其可移植；独立的标准 Windows 作业保留了这项信号。

**将原生 Windows 纳入必需聚合。** 标准 Windows 容量比 Wine 阻断路径更慢且更不稳定，因此继续作为独立检查。

## 后果

只要 Aurora 可用 GitHub-hosted 容量，必需的拉取请求就可以执行。标准 Linux 作业的并发低于上游企业级拓扑，因此可能耗时更长。GitHub Actions 账户级账单或 spending limit 失败仍可能阻止标准托管作业启动；这种外部条件会与运行器标签不可用分开报告。
