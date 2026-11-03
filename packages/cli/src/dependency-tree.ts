/**
 * An app's installed dependency tree, read from the text `bun.lock` (RFC 0039 §3):
 * one entry per installed instance, since one package can be installed at several
 * versions, with its path from every direct dependency. Pure: the lockfile text in,
 * the tree out. A nested copy is keyed `parent/child` in `packages`, and a
 * dependency resolves to the nearest key up that chain, as Bun installs it.
 */
import type { GraphCoverage } from './application-graph'

export const LOCKFILE = 'bun.lock'
export const BINARY_LOCKFILE = 'bun.lockb'

type DeclaredGroup = 'prod' | 'dev' | 'optional' | 'peer'

export interface DependencyInstance {
  /** `${name}@${version}`; a workspace package's version is its `workspace:<path>`. */
  id: string
  name: string
  version: string
  integrity?: string
  direct: boolean
  /** 0 for a direct dependency. */
  depth: number
  /** Per direct dependency: one shortest path from it to this instance, both ends included. */
  paths: Record<string, string[]>
  /** How the app's own manifest declares it; empty for a transitive package. */
  declaredAs: DeclaredGroup[]
  /** Reachable from `dependencies` or `optionalDependencies`, which `bun install --production` installs. */
  installedInProduction: boolean
}

export interface DependencyTree {
  coverage: GraphCoverage
  packages: DependencyInstance[]
}

interface Dependencies {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export interface BunLock {
  lockfileVersion: number
  workspaces: Record<string, Dependencies & { name?: string }>
  packages: Record<string, unknown[]>
}

export type LockReading = { kind: 'read'; lock: BunLock } | { kind: 'unreadable'; reason: string }

const SUPPORTED_LOCKFILE_VERSIONS = new Set([0, 1])

export function readBunLock(text: string): LockReading {
  let parsed: unknown
  try {
    parsed = Bun.JSONC.parse(text)
  } catch (error) {
    return { kind: 'unreadable', reason: `${LOCKFILE} does not parse (${error instanceof Error ? error.message : String(error)})` }
  }
  const lock = parsed as Partial<BunLock>
  if (typeof lock?.lockfileVersion !== 'number' || !SUPPORTED_LOCKFILE_VERSIONS.has(lock.lockfileVersion)) {
    return { kind: 'unreadable', reason: `${LOCKFILE} has lockfileVersion ${String(lock?.lockfileVersion)}, which this reader does not know` }
  }
  if (typeof lock.workspaces !== 'object' || lock.workspaces === null || typeof lock.packages !== 'object' || lock.packages === null) {
    return { kind: 'unreadable', reason: `${LOCKFILE} has no workspaces or packages table` }
  }
  return { kind: 'read', lock: lock as BunLock }
}

/** `@scope/name@1.0.0` → ['@scope/name', '1.0.0']. */
function splitSpecifier(specifier: string): [string, string] | null {
  const at = specifier.indexOf('@', 1)
  return at <= 0 ? null : [specifier.slice(0, at), specifier.slice(at + 1)]
}

/** `a/@s/b/c` → ['a', '@s/b', 'c']: the package names a nested key passes through. */
function keyChain(key: string): string[] {
  const parts = key.split('/')
  const chain: string[] = []
  for (let index = 0; index < parts.length; index++) {
    chain.push(parts[index]!.startsWith('@') ? `${parts[index]}/${parts[++index]}` : parts[index]!)
  }
  return chain
}

interface Entry {
  key: string
  name: string
  version: string
  integrity?: string
  dependencies: Dependencies
}

function entryAt(lock: BunLock, key: string): Entry | null {
  const raw = lock.packages[key]
  if (!Array.isArray(raw) || typeof raw[0] !== 'string') return null
  const split = splitSpecifier(raw[0])
  if (!split) return null
  const [name, version] = split
  const workspace = version.startsWith('workspace:') ? lock.workspaces[version.slice('workspace:'.length)] : undefined
  const info = raw.find((element): element is Dependencies => typeof element === 'object' && element !== null && !Array.isArray(element))
  const integrity = raw.slice(1).find((element): element is string => typeof element === 'string' && /^sha\d+-/u.test(element))
  return { key, name, version, ...(integrity ? { integrity } : {}), dependencies: workspace ?? info ?? {} }
}

/** The key Bun installed `name` under for a package at `from`: the nearest one up the nesting chain. */
function resolveKey(lock: BunLock, from: string | null, name: string): string | null {
  const chain = from === null ? [] : keyChain(from)
  for (let length = chain.length; length >= 0; length--) {
    const key = [...chain.slice(0, length), name].join('/')
    if (lock.packages[key] !== undefined) return key
  }
  return null
}

/** What installing `entry` brings along; a package's own devDependencies never install for its consumer. */
function childrenOf(entry: Entry): Array<{ name: string; optional: boolean }> {
  const { dependencies, optionalDependencies, peerDependencies } = entry.dependencies
  return [
    ...Object.keys(dependencies ?? {}).map((name) => ({ name, optional: false })),
    ...Object.keys(optionalDependencies ?? {}).map((name) => ({ name, optional: true })),
    // A peer is the consumer's to provide, so a missing one is Bun's warning, not a gap in the tree.
    ...Object.keys(peerDependencies ?? {}).map((name) => ({ name, optional: true })),
  ]
}

/** `workspace` is the app's key under `workspaces`: `""` for a standalone app, `examples/blog` inside a monorepo. */
export function dependencyTree(lock: BunLock, workspace = ''): DependencyTree {
  const root = lock.workspaces[workspace]
  if (!root) {
    return { coverage: { status: 'unavailable', reasons: [{ code: 'no-workspace', message: `${LOCKFILE} has no workspace "${workspace}".` }] }, packages: [] }
  }

  const declared = new Map<string, DeclaredGroup[]>()
  const declare = (group: DeclaredGroup, names: Record<string, string> | undefined) => {
    for (const name of Object.keys(names ?? {})) declared.set(name, [...(declared.get(name) ?? []), group])
  }
  declare('prod', root.dependencies)
  declare('dev', root.devDependencies)
  declare('optional', root.optionalDependencies)
  declare('peer', root.peerDependencies)

  const reasons: GraphCoverage['reasons'] = []
  const instances = new Map<string, DependencyInstance>()
  const production = new Set<string>()

  for (const [direct, groups] of declared) {
    const directKey = resolveKey(lock, null, direct)
    if (directKey === null) {
      if (!groups.every((group) => group === 'optional' || group === 'peer')) {
        reasons.push({ code: 'unresolved', message: `${direct} is declared by the app but has no entry in ${LOCKFILE}.` })
      }
      continue
    }
    const inProduction = groups.includes('prod') || groups.includes('optional')
    const queue: Array<{ key: string; path: string[] }> = [{ key: directKey, path: [direct] }]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const { key, path } = queue.shift()!
      if (seen.has(key)) continue
      seen.add(key)
      const entry = entryAt(lock, key)
      if (!entry) {
        reasons.push({ code: 'unreadable-entry', message: `${LOCKFILE} entry "${key}" is not a package entry this reader knows.` })
        continue
      }
      const id = `${entry.name}@${entry.version}`
      const instance = instances.get(id) ?? {
        id,
        name: entry.name,
        version: entry.version,
        ...(entry.integrity ? { integrity: entry.integrity } : {}),
        direct: false,
        depth: Number.POSITIVE_INFINITY,
        paths: {},
        declaredAs: [],
        installedInProduction: false,
      }
      if (path.length === 1) {
        instance.direct = true
        instance.declaredAs = groups
      }
      instance.depth = Math.min(instance.depth, path.length - 1)
      instance.paths[direct] ??= path
      if (inProduction) production.add(id)
      instances.set(id, instance)
      for (const child of childrenOf(entry)) {
        const childKey = resolveKey(lock, key, child.name)
        if (childKey === null) {
          if (!child.optional) reasons.push({ code: 'unresolved', message: `${entry.name}@${entry.version} depends on ${child.name}, which has no entry in ${LOCKFILE}.` })
          continue
        }
        queue.push({ key: childKey, path: [...path, child.name] })
      }
    }
  }

  const packages = [...instances.values()]
    .map((instance) => ({ ...instance, installedInProduction: production.has(instance.id) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  const unique = [...new Map(reasons.map((reason) => [reason.message, reason])).values()]
  return { coverage: { status: unique.length === 0 ? 'complete' : 'partial', reasons: unique }, packages }
}
