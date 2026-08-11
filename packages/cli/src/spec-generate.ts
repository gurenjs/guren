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
/**
 * One input to a spec view: the pattern `check --spec --changed` matches
 * changed files against, and the name the docs viewer draws as the
 * derivation edge. Pairing them in one entry is what keeps the gate and
 * the graph on the same list — two parallel arrays drift the moment a
 * pattern is added without its label.
 */
export interface SpecViewSource {
  pattern: RegExp
  label: string
}

export interface SpecViewDescriptor {
  fileName: string
  sources: SpecViewSource[]
  generate: (cwd: string, routesFile?: string) => Promise<SpecArtifact>
}

const SCHEMA_SOURCES: SpecViewSource[] = [
  { pattern: /^db\/schema\.ts$/, label: 'db/schema.ts' },
  { pattern: /^modules\/[^/]+\/db\/schema\.ts$/, label: 'db/schema.ts' },
]
const MODEL_SOURCES: SpecViewSource[] = [
  { pattern: /(^|\/)app\/Models\//, label: 'app/Models/' },
]

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
    sources: [
      { pattern: /^routes\//, label: 'routes/' },
      // A module feeds the route graph through a runtime import:
      // `loadRouteDefinitions` evaluates `modules/<name>/index.ts` and
      // whatever the registrar it names reaches from there — `routes.ts`,
      // files under `routes/` (where `make:route --module` writes), or any
      // other module file holding a prefix constant or helper. Like the
      // modules view's any-source rule, the pattern matches that honest
      // input set rather than an allow-list of conventional names — an
      // allow-list of `routes.ts`/`index.ts` is how a stale screens.md
      // once slipped through `--changed`, and over-selection only costs a
      // regeneration.
      { pattern: /^modules\/[^/]+\//, label: 'modules/' },
      { pattern: /(^|\/)app\/Http\/Controllers\//, label: 'app/Http/Controllers/' },
      { pattern: /^resources\/js\/pages\//, label: 'resources/js/pages/' },
    ],
    generate: (cwd, routesFile) => generateScreensSpec(cwd, routesFile),
  },
  {
    // The module map scans static imports across the whole project, so
    // any importable source file is honestly one of its inputs.
    fileName: 'modules.md',
    sources: [{ pattern: /\.(ts|tsx|mts|js|jsx|mjs)$/, label: '(all source files)' }],
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
