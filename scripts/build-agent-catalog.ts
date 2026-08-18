/**
 * Render and audit the agent-catalog payload published to gurenjs/agent-skills
 * (RFC 0011).
 *
 * The payload is the on-ramp Guren ships into agent catalogs — the Claude
 * Code plugin marketplace, the Agent Skills CLI, and Agent Plugins v1
 * clients. Its sources live in `packages/cli/templates/agent-catalog/`; this
 * script renders them into a directory and, in `--check` mode, asserts the
 * facts the rendered text claims about the CLI:
 *
 * - every `guren <command>` a skill names — bare or after `bunx` — is a
 *   command the CLI registers, and every `--flag` on that line is one the
 *   command declares. Read from the registry `packages/cli/src/commands.ts`
 *   exports, not from a hand-kept list.
 * - every agent target the skills offer is in `AGENT_TARGETS`.
 * - the minimum-CLI claim is not ahead of the workspace version.
 * - the root `plugin.json` conforms to the vendored Agent Plugins v1 schema,
 *   whose top-level field set is closed.
 *
 * The rendered payload is not committed to this repository (see the RFC for
 * why); `--check` renders into a temporary directory and discards it. The
 * publish step renders once, runs these same assertions, and pushes that
 * same tree.
 *
 * `--check` also enforces the changeset gate: if any input this script reads
 * changed relative to the base ref, a changeset naming `@guren/cli` must be
 * present, because the plugin's version is the CLI's and a payload published
 * under an unchanged version is one every installed copy skips forever.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { AGENT_TARGETS } from '../packages/cli/src/agent-targets'
import { builtinSubCommands } from '../packages/cli/src/commands'
import { repoRoot } from './workspace-packages'

const TEMPLATE_DIR = 'packages/cli/templates/agent-catalog'
const CLI_MANIFEST = 'packages/cli/package.json'
const CREATE_APP_MANIFEST = 'packages/create-app/package.json'
const LICENSE = 'LICENSE'

/**
 * The oldest `@guren/cli` whose `agent:init` accepts `--target`. The skills
 * tell users older CLIs need an upgrade for multi-agent installs. Asserted
 * `<=` the workspace version so it can never claim a future release.
 */
const MIN_CLI_FOR_TARGETS = '2.5.0'

const PORTABLE_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

/**
 * Everything the rendered payload derives from. The changeset gate watches
 * exactly this list, read from here so it cannot drift from what the
 * generator actually consumes.
 */
export const CATALOG_INPUTS = [
  `${TEMPLATE_DIR}/`,
  'scripts/build-agent-catalog.ts',
  'packages/cli/src/agent-targets.ts',
  CLI_MANIFEST,
  CREATE_APP_MANIFEST,
] as const

interface RenderContext {
  cliVersion: string
  minCli: string
  targets: readonly string[]
}

interface RenderedFile {
  /** Path relative to the payload root, POSIX. */
  path: string
  content: string
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function readContext(): Promise<RenderContext> {
  const cli = JSON.parse(await readFile(join(repoRoot, CLI_MANIFEST), 'utf8')) as { version?: string }
  if (!cli.version) {
    throw new Error(`${CLI_MANIFEST} has no version`)
  }
  return { cliVersion: cli.version, minCli: MIN_CLI_FOR_TARGETS, targets: AGENT_TARGETS }
}

function substitute(template: string, ctx: RenderContext, portableSchema: boolean): string {
  return template
    .replaceAll('__CLI_VERSION__', ctx.cliVersion)
    .replaceAll('__MIN_CLI__', ctx.minCli)
    .replaceAll('__AGENT_TARGETS__', ctx.targets.map((t) => `\`${t}\``).join(', '))
    .replaceAll('__PORTABLE_SCHEMA__', portableSchema ? `\n  "$schema": "${PORTABLE_SCHEMA_URL}",` : '')
}

const TOKEN_RE = /__[A-Z][A-Z_]*__/u

async function loadTemplate(name: string): Promise<string> {
  return readFile(join(repoRoot, TEMPLATE_DIR, name), 'utf8')
}

/** Every file of the payload, fully rendered. */
export async function renderCatalog(): Promise<RenderedFile[]> {
  const ctx = await readContext()
  const files: RenderedFile[] = []
  const add = (path: string, content: string): void => {
    const leftover = TOKEN_RE.exec(content)
    if (leftover) {
      throw new Error(`Unrendered token ${leftover[0]} in ${path}`)
    }
    files.push({ path, content })
  }

  const pluginRoot = 'plugins/guren'
  add('.claude-plugin/marketplace.json', substitute(await loadTemplate('marketplace.json.tpl'), ctx, false))
  add('README.md', substitute(await loadTemplate('README.md.tpl'), ctx, false))
  add('CONTRIBUTING.md', substitute(await loadTemplate('CONTRIBUTING.md.tpl'), ctx, false))
  add(`${pluginRoot}/README.md`, substitute(await loadTemplate('plugin-README.md.tpl'), ctx, false))
  // one manifest template, rendered twice: the portable Agent Plugins v1
  // manifest at the plugin root, and Claude Code's location without $schema
  const pluginTpl = await loadTemplate('plugin.json.tpl')
  add(`${pluginRoot}/plugin.json`, substitute(pluginTpl, ctx, true))
  add(`${pluginRoot}/.claude-plugin/plugin.json`, substitute(pluginTpl, ctx, false))

  const skillsDir = join(repoRoot, TEMPLATE_DIR, 'skills')
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillFile = join(skillsDir, entry.name, 'SKILL.md')
    add(`${pluginRoot}/skills/${entry.name}/SKILL.md`, substitute(await readFile(skillFile, 'utf8'), ctx, false))
  }

  // LICENSE is copied, not templated: the published license can never
  // diverge from the framework's
  const license = await readFile(join(repoRoot, LICENSE), 'utf8')
  add('LICENSE', license)
  add(`${pluginRoot}/LICENSE`, license)

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

export async function writeCatalog(outDir: string): Promise<RenderedFile[]> {
  const files = await renderCatalog()
  for (const file of files) {
    const dest = join(outDir, file.path)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, file.content, 'utf8')
  }
  return files
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * A `guren <command> [--flags…]` occurrence: bare or after `bunx`, in a code
 * fence or inline. Captures the command and the rest of the line, from which
 * flags are read. Stops at the closing backtick of an inline span so prose
 * after it is not mistaken for flags.
 */
const GUREN_INVOCATION_RE = /\b(?:bunx\s+)?guren\s+([a-z][a-z0-9:-]*)([^\n`]*)/gu
const FLAG_RE = /(?:^|\s)--([a-z][a-z0-9-]*)/gu

type ArgsShape = Record<string, unknown> | undefined

async function declaredArgs(command: string): Promise<Set<string>> {
  const def = (builtinSubCommands as Record<string, { args?: ArgsShape | (() => ArgsShape | Promise<ArgsShape>) }>)[command]
  if (!def) return new Set()
  const args = typeof def.args === 'function' ? await def.args() : def.args
  const names = new Set<string>(Object.keys(args ?? {}))
  // every citty command accepts these two, undeclared
  names.add('help')
  names.add('version')
  return names
}

export async function assertCommandsAndFlags(files: readonly RenderedFile[]): Promise<string[]> {
  const registered = new Set(Object.keys(builtinSubCommands))
  const problems: string[] = []
  const flagCache = new Map<string, Set<string>>()
  for (const file of files) {
    if (!file.path.endsWith('.md')) continue
    for (const match of file.content.matchAll(GUREN_INVOCATION_RE)) {
      const [, command, rest] = match
      // `guren --version` is the root command; `guren` followed by a
      // placeholder like `<cmd>` is not an invocation
      if (command === undefined || command.startsWith('<')) continue
      if (!registered.has(command)) {
        problems.push(`${file.path}: names \`guren ${command}\`, which the CLI does not register`)
        continue
      }
      let declared = flagCache.get(command)
      if (!declared) {
        declared = await declaredArgs(command)
        flagCache.set(command, declared)
      }
      for (const flag of (rest ?? '').matchAll(FLAG_RE)) {
        const name = flag[1]
        if (name && !declared.has(name)) {
          problems.push(`${file.path}: \`guren ${command} --${name}\` — \`${command}\` declares no \`--${name}\``)
        }
      }
    }
  }
  return problems
}

export function assertTargets(files: readonly RenderedFile[]): string[] {
  // the rendered target list is a substitution of AGENT_TARGETS itself, so
  // the assertion is that no skill hand-names a target outside that set
  const known = new Set<string>(AGENT_TARGETS)
  const problems: string[] = []
  const targetListRe = /--target\s+([a-z,]+)/gu
  for (const file of files) {
    for (const match of file.content.matchAll(targetListRe)) {
      for (const t of (match[1] ?? '').split(',')) {
        if (t && t !== 'all' && !known.has(t)) {
          problems.push(`${file.path}: --target ${t} is not in AGENT_TARGETS`)
        }
      }
    }
  }
  return problems
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export async function assertMinCli(): Promise<string[]> {
  const ctx = await readContext()
  return compareSemver(ctx.minCli, ctx.cliVersion) > 0
    ? [`MIN_CLI_FOR_TARGETS ${ctx.minCli} is ahead of the workspace @guren/cli ${ctx.cliVersion}`]
    : []
}

/**
 * Agent Plugins v1 `plugin.json` conformance, against the vendored schema.
 * The schema is small and closed, so it is enforced directly rather than via
 * a validator dependency; the vendored copy is read so a field added upstream
 * shows up as a diff here, not as a silent pass.
 */
export async function assertPortableManifest(files: readonly RenderedFile[]): Promise<string[]> {
  const schema = JSON.parse(await readFile(join(repoRoot, TEMPLATE_DIR, 'plugin.schema.json'), 'utf8')) as {
    required?: string[]
    properties?: Record<string, unknown>
    additionalProperties?: boolean
  }
  const file = files.find((f) => f.path === 'plugins/guren/plugin.json')
  if (!file) return ['plugins/guren/plugin.json was not rendered']
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(file.content) as Record<string, unknown>
  } catch (error) {
    return [`plugins/guren/plugin.json is not valid JSON: ${(error as Error).message}`]
  }
  const problems: string[] = []
  for (const key of schema.required ?? []) {
    if (!(key in manifest)) problems.push(`plugin.json: missing required field "${key}"`)
  }
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties ?? {}))
    for (const key of Object.keys(manifest)) {
      if (!allowed.has(key)) problems.push(`plugin.json: field "${key}" is not permitted (closed schema)`)
    }
  }
  if (manifest.$schema !== PORTABLE_SCHEMA_URL) {
    problems.push(`plugin.json: $schema must be ${PORTABLE_SCHEMA_URL}`)
  }
  const name = manifest.name
  if (typeof name !== 'string' || !/^[a-z0-9](?:[a-z0-9]|[-.](?![-.]))*[a-z0-9]$|^[a-z0-9]$/u.test(name) || name.length > 64) {
    problems.push(`plugin.json: name "${String(name)}" violates the Agent Plugins name rule`)
  }
  // Claude's copy must be the same manifest minus $schema
  const claude = files.find((f) => f.path === 'plugins/guren/.claude-plugin/plugin.json')
  if (claude) {
    const c = JSON.parse(claude.content) as Record<string, unknown>
    const { $schema: _s, ...portableRest } = manifest
    if (JSON.stringify(c) !== JSON.stringify(portableRest)) {
      problems.push('plugins/guren/.claude-plugin/plugin.json differs from the root manifest beyond $schema')
    }
  }
  return problems
}

/**
 * Sources changed ⇒ a `@guren/cli` changeset is present. Compared against
 * `base` (a ref or SHA). Callers on shallow checkouts must fetch it first.
 */
export async function assertChangesetGate(base: string): Promise<string[]> {
  // three-dot needs a merge base, which a shallow checkout may not have even
  // after fetching the base ref; fall back to two-dot (base tip vs HEAD),
  // which over-reports on a stale branch but never under-reports
  let diff = Bun.spawnSync(['git', 'diff', '--name-only', `${base}...HEAD`], { cwd: repoRoot })
  if (!diff.success) {
    diff = Bun.spawnSync(['git', 'diff', '--name-only', `${base}..HEAD`], { cwd: repoRoot })
  }
  if (!diff.success) {
    return [`could not diff against ${base}: ${diff.stderr.toString().trim()} — fetch the base ref before running --check`]
  }
  const changed = diff.stdout.toString().split('\n').filter(Boolean)
  const touched = changed.filter((f) => CATALOG_INPUTS.some((input) => (input.endsWith('/') ? f.startsWith(input) : f === input)))
  if (touched.length === 0) return []
  // a version bump in the CLI manifest is itself the release PR — no changeset expected there
  if (touched.every((f) => f === CLI_MANIFEST || f === CREATE_APP_MANIFEST)) return []

  const changesetDir = join(repoRoot, '.changeset')
  let names: string[] = []
  try {
    names = (await readdir(changesetDir)).filter((n) => n.endsWith('.md') && n !== 'README.md')
  } catch {
    // no .changeset dir — fall through to the failure below
  }
  for (const name of names) {
    const body = await readFile(join(changesetDir, name), 'utf8')
    if (/^---[\s\S]*?["']@guren\/cli["']\s*:/mu.test(body)) return []
  }
  return [
    `catalog inputs changed (${touched.join(', ')}) but no .changeset/*.md names "@guren/cli". ` +
      'The plugin version is the CLI version and a payload published under an unchanged version is one every installed copy skips forever; add a @guren/cli changeset.',
  ]
}

/**
 * `claude plugin validate --strict` on the rendered plugin and marketplace —
 * the same check the community-marketplace review pipeline runs. Verified to
 * run without authentication (2026-08-18). Three outcomes, kept distinct:
 * `pass`, `fail` (validation errors), and `unavailable` (no `claude` on PATH,
 * or it could not be spawned). An unavailable check is not a green one; the
 * caller decides whether to block on it, but it is never reported as pass.
 */
type ValidateOutcome = { kind: 'pass' } | { kind: 'fail'; output: string } | { kind: 'unavailable'; reason: string }

export async function claudePluginValidate(payloadDir: string): Promise<ValidateOutcome> {
  const which = Bun.spawnSync(['sh', '-c', 'command -v claude'], {})
  if (!which.success) {
    return { kind: 'unavailable', reason: '`claude` is not on PATH' }
  }
  for (const target of [join(payloadDir, 'plugins', 'guren'), payloadDir]) {
    const run = Bun.spawnSync(['claude', 'plugin', 'validate', target, '--strict'], {})
    const output = run.stdout.toString() + run.stderr.toString()
    if (!run.success) {
      // distinguish "ran and found problems" from "could not run"
      if (/validation (failed|error)|✖|error/iu.test(output)) {
        return { kind: 'fail', output: output.trim() }
      }
      return { kind: 'unavailable', reason: output.trim() || `exit ${run.exitCode}` }
    }
  }
  return { kind: 'pass' }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** 0 clean, 1 a rule failed, 2 the gate could not fully run. */
async function check(base: string | undefined, requireValidate: boolean): Promise<number> {
  const files = await renderCatalog()
  const problems = [
    ...(await assertCommandsAndFlags(files)),
    ...assertTargets(files),
    ...(await assertMinCli()),
    ...(await assertPortableManifest(files)),
    ...(base ? await assertChangesetGate(base) : []),
  ]
  if (problems.length > 0) {
    console.error(`agent-catalog audit failed:\n${problems.map((p) => `  ${p}`).join('\n')}`)
    return 1
  }

  // render once and validate that same tree, then discard it
  const dir = await mkdtemp(join(tmpdir(), 'guren-agent-catalog-'))
  let outcome: ValidateOutcome
  try {
    await writeCatalog(dir)
    outcome = await claudePluginValidate(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  if (outcome.kind === 'fail') {
    console.error(`claude plugin validate --strict failed:\n${outcome.output}`)
    return 1
  }
  if (outcome.kind === 'unavailable') {
    console.error(`claude plugin validate could not run: ${outcome.reason}`)
    if (requireValidate) {
      console.error('An unavailable check is not a green one; run with the Claude Code CLI on PATH, or without --require-validate to record this as informational.')
      return 2
    }
    console.log(`agent-catalog audit passed the derived-fact rules (${files.length} files rendered${base ? `, changeset gate vs ${base}` : ''}); manifest validation was unavailable.`)
    return 0
  }
  console.log(`agent-catalog audit passed (${files.length} files rendered${base ? `, changeset gate vs ${base}` : ''}; claude plugin validate --strict ok).`)
  return 0
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const baseIdx = args.indexOf('--base')
  const base = baseIdx >= 0 ? args[baseIdx + 1] : undefined
  if (args.includes('--check')) {
    process.exitCode = await check(base, args.includes('--require-validate'))
    return
  }
  const outDir = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1]! : undefined
  if (!outDir) {
    throw new Error('Usage: build-agent-catalog.ts --out <dir> | --check [--base <ref>]')
  }
  await rm(outDir, { recursive: true, force: true })
  const files = await writeCatalog(outDir)
  console.log(`Rendered ${files.length} files into ${relative(process.cwd(), outDir) || '.'}`)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
