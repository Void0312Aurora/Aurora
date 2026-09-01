/**
 * Verify that executable deploy manifests supply every required workspace peer
 * in their dependency graphs. With automatic peer installation disabled, a
 * missing root peer otherwise fails only when a packaged Cordis plugin loads.
 */
import { globSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

export interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

export interface WorkspacePackage {
  path: string
  manifest: PackageManifest
}

const root = resolve(import.meta.dirname, '..')
const defaultManifestPaths = ['python/sdk-runtime/package.json'] as const

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { manifest: { type: 'string', multiple: true } },
  })
  const manifestPaths = values.manifest?.length === 0 || values.manifest === undefined
    ? defaultManifestPaths
    : values.manifest
  const workspace = await loadWorkspacePackages()
  const failures: string[] = []
  let totalPackages = 0

  for (const manifestPath of manifestPaths) {
    const absolutePath = resolve(root, manifestPath)
    const runtimeManifest = await loadManifest(absolutePath)
    const runtimeName = runtimeManifest.name ?? manifestPath
    const result = verifyRuntimeClosure(runtimeName, runtimeManifest.dependencies ?? {}, workspace)
    totalPackages += result.packageCount
    failures.push(...result.failures)
  }

  if (failures.length > 0) {
    console.error('verify-runtime-closure: required workspace peers are missing from one or more deploy manifests:')
    for (const failure of failures) console.error(`  ${failure}`)
    process.exit(1)
  }

  console.log(`verify-runtime-closure: ${totalPackages} workspace package visits form closed runtime dependency graphs.`)
}

/**
 * Check one deploy manifest against a workspace package graph.
 * @param runtimeName - name used to identify the deploy root in diagnostics.
 * @param runtimeDependencies - direct dependencies declared by the deploy root.
 * @param workspace - all package manifests available to the workspace.
 * @returns missing required peers and the number of visited workspace packages.
 */
export function verifyRuntimeClosure(
  runtimeName: string,
  runtimeDependencies: Readonly<Record<string, string>>,
  workspace: ReadonlyMap<string, WorkspacePackage>,
): { failures: string[]; packageCount: number } {
  const parents = new Map<string, string | undefined>()
  const queue: string[] = []

  for (const dependency of Object.keys(runtimeDependencies).sort()) {
    if (!workspace.has(dependency)) continue
    parents.set(dependency, undefined)
    queue.push(dependency)
  }

  const failures: string[] = []
  for (let index = 0; index < queue.length; index += 1) {
    const packageName = queue[index]
    if (packageName === undefined) continue
    const current = workspace.get(packageName)
    if (current === undefined) continue
    const peers = current.manifest.peerDependencies ?? {}
    const peerMeta = current.manifest.peerDependenciesMeta ?? {}
    for (const peer of Object.keys(peers).sort()) {
      if (!workspace.has(peer) || peerMeta[peer]?.optional === true) continue
      if (runtimeDependencies[peer]?.startsWith('workspace:') === true) continue
      failures.push(`${formatChain(runtimeName, packageName, parents)} -> ${peer}`)
    }
    const dependencies = {
      ...current.manifest.dependencies,
      ...current.manifest.optionalDependencies,
    }
    for (const dependency of Object.keys(dependencies).sort()) {
      if (!workspace.has(dependency) || parents.has(dependency)) continue
      parents.set(dependency, packageName)
      queue.push(dependency)
    }
  }

  return { failures, packageCount: queue.length }
}

/** Load all workspace package manifests that can contribute runtime edges. */
export async function loadWorkspacePackages(): Promise<Map<string, WorkspacePackage>> {
  const paths = globSync([
    'packages/*/*/package.json',
    'vendor/*/package.json',
    'apps/*/package.json',
    'native/landlock-run/package.json',
    'native/landlock-run/packages/*/package.json',
  ], { cwd: root })
    .sort()
    .map(relative => resolve(root, relative))
  const result = new Map<string, WorkspacePackage>()
  for (const path of paths) {
    const manifest = await loadManifest(path)
    if (manifest.name !== undefined) result.set(manifest.name, { path, manifest })
  }
  return result
}

async function loadManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest
}

function formatChain(
  runtimeName: string,
  packageName: string,
  parents: ReadonlyMap<string, string | undefined>,
): string {
  const chain = [packageName]
  let parent = parents.get(packageName)
  while (parent !== undefined) {
    chain.unshift(parent)
    parent = parents.get(parent)
  }
  return [runtimeName, ...chain].join(' -> ')
}
