import { resolve } from 'node:path'
import { consola } from 'consola'
import { writeFileSafe } from './utils'
import { generateErSpec } from './spec-er'
import { generateDomainSpec } from './spec-domain'
import { generateScreensSpec } from './spec-screens'
import { generateModulesSpec } from './spec-modules'
import { SPEC_DIR, type SpecArtifact } from './spec-artifact'

export { SPEC_DIR, SPEC_BANNER, compareStrings, type SpecArtifact } from './spec-artifact'

export interface SpecGenerateOptions {
  cwd?: string
  routesFile?: string
}

/**
 * One entry per spec view: the generator plus the POSIX-relative file
 * patterns whose changes can alter its output. `check --spec --changed`
 * regenerates only the views whose sources changed — the single list that
 * keeps the gate and the generators from drifting apart.
 */
export interface SpecViewDescriptor {
  fileName: string
  sources: RegExp[]
  generate: (cwd: string, routesFile?: string) => Promise<SpecArtifact>
}

const SCHEMA_SOURCES = [/^db\/schema\.ts$/, /^modules\/[^/]+\/db\/schema\.ts$/]
const MODEL_SOURCES = [/(^|\/)app\/Models\//]

export const SPEC_VIEWS: SpecViewDescriptor[] = [
  {
    fileName: 'er.md',
    sources: [...SCHEMA_SOURCES, ...MODEL_SOURCES],
    generate: (cwd) => generateErSpec(cwd),
  },
  {
    fileName: 'domain.md',
    sources: MODEL_SOURCES,
    generate: (cwd) => generateDomainSpec(cwd),
  },
  {
    fileName: 'screens.md',
    sources: [/^routes\//, /^modules\/[^/]+\/(routes|index)\.ts$/, /(^|\/)app\/Http\/Controllers\//, /^resources\/js\/pages\//],
    generate: (cwd, routesFile) => generateScreensSpec(cwd, routesFile),
  },
  {
    // The module map scans static imports across the whole project, so
    // any importable source file is honestly one of its inputs.
    fileName: 'modules.md',
    sources: [/\.(ts|tsx|mts|js|jsx|mjs)$/],
    generate: (cwd) => generateModulesSpec(cwd),
  },
]

/**
 * The selected spec views, generated in memory. `check --spec` diffs these
 * against the committed files; `spec:generate` writes them.
 */
export async function generateSpecArtifacts(
  options: SpecGenerateOptions = {},
  views: SpecViewDescriptor[] = SPEC_VIEWS,
): Promise<SpecArtifact[]> {
  const cwd = resolve(options.cwd ?? process.cwd())
  return Promise.all(views.map((view) => view.generate(cwd, options.routesFile)))
}

export async function writeSpecArtifacts(options: SpecGenerateOptions = {}): Promise<string[]> {
  const cwd = resolve(options.cwd ?? process.cwd())
  const artifacts = await generateSpecArtifacts({ ...options, cwd })

  const written: string[] = []
  for (const artifact of artifacts) {
    const specPath = `${SPEC_DIR}/${artifact.fileName}`
    if (artifact.degraded) {
      // Writing a degraded view would replace real content with a hollow
      // document that then reads as "in sync" — keep whatever is committed.
      consola.warn(`Skipped ${specPath} — ${artifact.degraded}`)
      continue
    }
    await writeFileSafe(resolve(cwd, SPEC_DIR, artifact.fileName), artifact.content, { force: true })
    written.push(specPath)
    consola.success(`Spec view generated at ${specPath}`)
  }
  return written
}
