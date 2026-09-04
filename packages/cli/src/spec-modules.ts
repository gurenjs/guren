import { dirname, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  collectFiles,
  discoverModelFiles,
  listAppRoots,
  classNameFromPath,
  toPosixRelative,
  moduleNameFromRelPath,
  IMPORTABLE_EXTENSIONS,
  NON_SOURCE_DIR_NAMES,
} from './discovery'
import { specHeader, compareStrings, mermaidToken, type SpecArtifact } from './spec-artifact'

/** Label for the application root, which has no module name of its own. */
const APP = 'app'

/**
 * Top-level `import`/`export ... from '...'` specifiers. Regex rather than AST on
 * purpose: this view only needs to know which locations reference each other, so a false
 * edge from a specifier inside a comment costs less than parsing every file in the
 * project. The clause spans lines so multi-line imports count, and can never cross a
 * quote. Type-only imports count too: a shared type is a real conceptual dependency.
 */
const IMPORT_FROM_REGEX = /(?:^|\n)\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g

/**
 * Side-effect imports (`import '@/modules/billing/setup'`), which have no `from` for the
 * pattern above to anchor on. A separate pattern rather than an optional `from` clause,
 * which would make the multi-line case above backtrack. `export '...'` is not valid syntax.
 */
const SIDE_EFFECT_IMPORT_REGEX = /(?:^|\n)\s*import\b\s*['"]([^'"]+)['"]/g

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const regex of [IMPORT_FROM_REGEX, SIDE_EFFECT_IMPORT_REGEX]) {
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(source)) !== null) {
      specifiers.push(match[1])
    }
  }
  return specifiers
}

/**
 * Project-relative POSIX path a specifier points at, or `null` when it leaves the
 * project. Existence is deliberately not checked: attribution only needs the path prefix,
 * and skipping the probes keeps the output a pure function of the sources.
 */
function specifierRelPath(cwd: string, importerAbsPath: string, specifier: string): string | null {
  if (specifier.startsWith('.')) {
    const rel = toPosixRelative(cwd, resolve(dirname(importerAbsPath), specifier))
    return rel.startsWith('..') ? null : rel
  }
  // `@/` resolves from the project root (tsconfig paths + the Vite alias).
  if (specifier.startsWith('@/')) return specifier.slice(2)
  // A bare `modules/billing/...` specifier is project-shaped, not a package.
  if (specifier.startsWith('modules/')) return specifier
  return null
}

/**
 * Location a project-relative path belongs to. The trailing slash lets a bare barrel
 * import (`@/modules/billing`) match the same way a file path inside the module does.
 */
function locationOf(relPath: string): string {
  return moduleNameFromRelPath(`${relPath}/`) ?? APP
}

/** Dependency edges as `from` → set of `to` locations. */
type EdgeMap = Map<string, Set<string>>

async function collectDependencyEdges(cwd: string): Promise<EdgeMap> {
  const files = await collectFiles(cwd, IMPORTABLE_EXTENSIONS, NON_SOURCE_DIR_NAMES)
  const sources = await Promise.all(files.map((absPath) => readFile(absPath, 'utf-8')))

  const edges: EdgeMap = new Map()
  files.forEach((absPath, index) => {
    const from = locationOf(toPosixRelative(cwd, absPath))

    for (const specifier of extractImportSpecifiers(sources[index])) {
      const targetPath = specifierRelPath(cwd, absPath, specifier)
      if (targetPath === null) continue
      const to = locationOf(targetPath)
      if (to === from) continue
      const targets = edges.get(from) ?? new Set<string>()
      targets.add(to)
      edges.set(from, targets)
    }
  })

  return edges
}

interface LocationModel {
  name: string
  filePath: string
}

/** Class name + file path per location, sorted by class name then path. */
async function collectModelsByLocation(cwd: string): Promise<Map<string, LocationModel[]>> {
  const files = await discoverModelFiles(cwd)
  const byLocation = new Map<string, LocationModel[]>()

  for (const absPath of files) {
    const filePath = toPosixRelative(cwd, absPath)
    const location = locationOf(filePath)
    const models = byLocation.get(location) ?? []
    models.push({ name: classNameFromPath(absPath), filePath })
    byLocation.set(location, models)
  }

  for (const models of byLocation.values()) {
    models.sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a.filePath, b.filePath))
  }
  return byLocation
}

/** Mermaid node id — module names may contain characters Mermaid can't take bare. */
function nodeId(location: string): string {
  return `m_${mermaidToken(location)}`
}

/**
 * The context map: every module (RFC 0002), the models it owns, and the dependency edges
 * between modules and the application root. An app with no `modules/` directory still
 * gets a valid document — a single `app` node.
 */
export async function generateModulesSpec(cwd: string): Promise<SpecArtifact> {
  const [roots, modelsByLocation, edges] = await Promise.all([
    listAppRoots(cwd),
    collectModelsByLocation(cwd),
    collectDependencyEdges(cwd),
  ])

  const moduleNames = roots
    .map((root) => root.module)
    .filter((name): name is string => name !== null)
    .sort(compareStrings)

  const dependenciesOf = (location: string): string[] =>
    [...(edges.get(location) ?? [])].sort(compareStrings)

  // The app root is a node when it owns models or takes part in a dependency — and
  // always when there are no modules, so the document is never empty.
  const appParticipates =
    (modelsByLocation.get(APP)?.length ?? 0) > 0
    || edges.has(APP)
    || [...edges.values()].some((targets) => targets.has(APP))
    || moduleNames.length === 0

  const locations = [...(appParticipates ? [APP] : []), ...moduleNames]

  const lines: string[] = specHeader('Modules', 'Application modules, the models each owns, and the dependencies between them.')
  lines.push(
    moduleNames.length > 0
      ? `Application modules under \`modules/\`, the models each owns, and the dependencies between them — `
        + `derived from the directory layout and static imports, not this document.`
      : `This app has no \`modules/\` directory — all code lives at the application root.`,
  )
  lines.push('')

  lines.push('```mermaid')
  lines.push('graph LR')
  for (const location of locations) {
    const models = modelsByLocation.get(location) ?? []
    const label = models.length > 0 ? `${location}<br/>${models.map((m) => m.name).join(', ')}` : location
    lines.push(`  ${nodeId(location)}["${label}"]`)
  }
  for (const from of [...edges.keys()].sort(compareStrings)) {
    for (const to of dependenciesOf(from)) {
      lines.push(`  ${nodeId(from)} --> ${nodeId(to)}`)
    }
  }
  lines.push('```')
  lines.push('')

  for (const location of locations) {
    lines.push(`## ${location}`)
    lines.push('')

    const dependsOn = dependenciesOf(location)
    if (dependsOn.length > 0) {
      lines.push(`Depends on: ${dependsOn.join(', ')}`)
      lines.push('')
    }

    const models = modelsByLocation.get(location) ?? []
    lines.push(`Models (${models.length}):`)
    lines.push('')
    if (models.length > 0) {
      for (const model of models) {
        lines.push(`- ${model.name} — ${model.filePath}`)
      }
    } else {
      lines.push('- none')
    }
    lines.push('')
  }

  return { fileName: 'modules.md', content: `${lines.join('\n').replace(/\n+$/, '')}\n` }
}
