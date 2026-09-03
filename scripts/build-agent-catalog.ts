/**
 * Render and audit the agent-catalog payload published to gurenjs/agent-skills
 * (RFC 0011). Sources live in `packages/cli/templates/agent-catalog/`; `--check`
 * renders them into a temporary directory (the payload is not committed here)
 * and asserts what the rendered text claims about the CLI:
 *
 * - every `guren <command>` a skill names, bare or after `bunx`, is registered,
 *   and every `--flag` on that line is declared — read from what the registry
 *   `packages/cli/src/commands.ts` exports, not from a hand-kept list.
 * - every agent target the skills offer is in `AGENT_TARGETS`.
 * - the minimum-CLI claim is not ahead of the workspace version.
 * - the root `plugin.json` conforms to the vendored Agent Plugins v1 schema.
 *
 * `--check` also enforces the changeset gate: if any input changed against the
 * base ref, a changeset naming `@guren/cli` must be present, since the plugin's
 * version is the CLI's and a payload published under an unchanged version is one
 * every installed copy skips forever. A diff that moves the CLI version is exempt.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import process from 'node:process'
import { AGENT_TARGETS } from '../packages/cli/src/agent-targets'
import { builtinSubCommands } from '../packages/cli/src/commands'
import { compareVersions } from '../packages/cli/src/codemods'
import { parseChangeset } from './smoke/core-semver-audit'
import { manifestAtRev, repoRoot, versionOf } from './workspace-packages'

const TEMPLATE_DIR = 'packages/cli/templates/agent-catalog'
/** Exported so the gate's tests name the manifest through the gate, not beside it. */
export const CLI_MANIFEST = 'packages/cli/package.json'
const LICENSE = 'LICENSE'

/**
 * `core.hooksPath` pointed at nothing, on every git command that creates or
 * clones a repository: the repository is fresh but hooks are not, and a global
 * `core.hooksPath` (or an `init.templateDir`) runs before this code reads a
 * single file. The rest of the maintainer's configuration is left alone — the
 * credential helper and SSH setup are how any of this reaches a remote.
 * Exported because publish-agent-catalog needs the same rule.
 */
export const NO_HOOKS = ['-c', 'core.hooksPath=']

/**
 * The oldest `@guren/cli` whose `agent:init` accepts `--target`. The skills
 * tell users older CLIs need an upgrade for multi-agent installs. Asserted
 * `<=` the workspace version so it can never claim a future release.
 */
const MIN_CLI_FOR_TARGETS = '2.5.0'

const PORTABLE_SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

/**
 * Everything the rendered payload derives from; the changeset gate watches this
 * same list, so it cannot drift from what the generator consumes.
 */
export const CATALOG_INPUTS = [
  `${TEMPLATE_DIR}/`, // templates, skills, and the vendored plugin.schema.json
  'scripts/build-agent-catalog.ts',
  'packages/cli/src/agent-targets.ts',
  CLI_MANIFEST,
  LICENSE,
] as const

interface RenderContext {
  cliVersion: string
  minCli: string
  targets: readonly string[]
}

export interface RenderedFile {
  /** Path relative to the payload root, POSIX. */
  path: string
  content: string
}

async function readContext(): Promise<RenderContext> {
  const cli = JSON.parse(await readFile(join(repoRoot, CLI_MANIFEST), 'utf8')) as { version?: string }
  if (!cli.version) {
    throw new Error(`${CLI_MANIFEST} has no version`)
  }
  // test hook only: lets the publish integration test render a second
  // version without editing packages/cli/package.json
  const cliVersion = process.env.GUREN_CATALOG_VERSION_OVERRIDE ?? cli.version
  return { cliVersion, minCli: MIN_CLI_FOR_TARGETS, targets: AGENT_TARGETS }
}

function substitute(template: string, ctx: RenderContext, portableSchema = false): string {
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
  add('.claude-plugin/marketplace.json', substitute(await loadTemplate('marketplace.json.tpl'), ctx))
  add('README.md', substitute(await loadTemplate('README.md.tpl'), ctx))
  add('CONTRIBUTING.md', substitute(await loadTemplate('CONTRIBUTING.md.tpl'), ctx))
  add(`${pluginRoot}/README.md`, substitute(await loadTemplate('plugin-README.md.tpl'), ctx))
  // one manifest template, rendered twice: the portable Agent Plugins v1
  // manifest at the plugin root, and Claude Code's location without $schema
  const pluginTpl = await loadTemplate('plugin.json.tpl')
  add(`${pluginRoot}/plugin.json`, substitute(pluginTpl, ctx, true))
  add(`${pluginRoot}/.claude-plugin/plugin.json`, substitute(pluginTpl, ctx))

  const skillsDir = join(repoRoot, TEMPLATE_DIR, 'skills')
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillFile = join(skillsDir, entry.name, 'SKILL.md')
    add(`${pluginRoot}/skills/${entry.name}/SKILL.md`, substitute(await readFile(skillFile, 'utf8'), ctx))
  }

  // LICENSE is copied, not templated: the published license can never
  // diverge from the framework's
  const license = await readFile(join(repoRoot, LICENSE), 'utf8')
  add('LICENSE', license)
  add(`${pluginRoot}/LICENSE`, license)

  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * `files` lets a caller that already rendered (`--check`) write that same array
 * rather than render a second time. Same tree either way.
 */
export async function writeCatalog(outDir: string, files?: readonly RenderedFile[]): Promise<readonly RenderedFile[]> {
  files ??= await renderCatalog()
  for (const file of files) {
    const dest = join(outDir, file.path)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, file.content, 'utf8')
  }
  return files
}

/**
 * A `guren <command> [--flags…]` occurrence, bare or after `bunx`, fenced or
 * inline. Stops at the closing backtick of an inline span so following prose is
 * not mistaken for flags.
 */
const GUREN_INVOCATION_RE = /\b(?:bunx\s+)?guren\s+(--version|[a-z][a-z0-9:-]*)([^\n`]*)/gu
const FLAG_RE = /(?:^|\s)--([a-z][a-z0-9-]*)/gu
/** Where one shell invocation ends and the next begins on the same line. */
const SHELL_SEPARATOR_RE = /\s*(?:&&|\|\||;|\|)\s*/u

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
      const [, command, restRaw] = match
      if (command === undefined || command.startsWith('<')) continue
      // the root command's own flag, always accepted; matched so the probe the
      // harness skill relies on is spelled as something the CLI has
      if (command === '--version') continue
      // flags belong to this invocation only up to the next shell separator:
      // `guren check && guren agent:init --target codex` must not hand --target
      // to check
      const rest = (restRaw ?? '').split(SHELL_SEPARATOR_RE)[0] ?? ''
      if (!registered.has(command)) {
        problems.push(`${file.path}: names \`guren ${command}\`, which the CLI does not register`)
        continue
      }
      let declared = flagCache.get(command)
      if (!declared) {
        declared = await declaredArgs(command)
        flagCache.set(command, declared)
      }
      for (const flag of rest.matchAll(FLAG_RE)) {
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

export async function assertMinCli(): Promise<string[]> {
  const ctx = await readContext()
  // `compareVersions` returns NaN for anything but an exact version (a
  // prerelease *is* exact), and `NaN > 0` is false, so an impossible comparison
  // would otherwise read as "not ahead" and pass.
  const order = compareVersions(ctx.minCli, ctx.cliVersion)
  if (Number.isNaN(order)) {
    return [`Cannot order MIN_CLI_FOR_TARGETS ${ctx.minCli} against the workspace @guren/cli ${ctx.cliVersion}`]
  }
  return order > 0
    ? [`MIN_CLI_FOR_TARGETS ${ctx.minCli} is ahead of the workspace @guren/cli ${ctx.cliVersion}`]
    : []
}

/**
 * The JSON Schema subset the vendored Agent Plugins v1 schema uses, enforced
 * without a validator dependency and driven by the vendored file rather than a
 * hand-copied rule — so the name pattern is the spec's own, admitting `a-.b`
 * where a stricter hand-written regex would not, and a field added upstream
 * shows up as a diff rather than a silent pass.
 */
type JsonSchema = {
  $id?: string
  type?: string
  const?: unknown
  required?: string[]
  properties?: Record<string, JsonSchema>
  // both forms are in use: `false` closes the root, and a schema constrains
  // every `extensions` namespace to an object
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  minLength?: number
  maxLength?: number
  pattern?: string
}

export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = 'plugin.json'): string[] {
  const problems: string[] = []
  const typeOf = (v: unknown): string => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v)
  if (schema.type !== undefined && typeOf(value) !== schema.type) {
    return [`${path}: expected ${schema.type}, got ${typeOf(value)}`]
  }
  if (schema.const !== undefined && value !== schema.const) {
    problems.push(`${path}: must be ${JSON.stringify(schema.const)}`)
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${path}: shorter than ${schema.minLength}`)
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path}: longer than ${schema.maxLength}`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      problems.push(`${path}: "${value}" does not match ${schema.pattern}`)
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => problems.push(...validateAgainstSchema(item, schema.items!, `${path}[${i}]`)))
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in obj)) problems.push(`${path}: missing required field "${key}"`)
    }
    const props = schema.properties ?? {}
    for (const [key, v] of Object.entries(obj)) {
      const sub = props[key]
      if (sub) {
        problems.push(...validateAgainstSchema(v, sub, `${path}.${key}`))
      } else if (schema.additionalProperties === false) {
        problems.push(`${path}: field "${key}" is not permitted (closed schema)`)
      } else if (typeof schema.additionalProperties === 'object') {
        // e.g. each `extensions` namespace must itself be an object
        problems.push(...validateAgainstSchema(v, schema.additionalProperties, `${path}.${key}`))
      }
    }
  }
  return problems
}

/**
 * `{}` is itself a valid JSON Schema accepting every document, so a gutted or
 * truncated vendored copy would turn this rule green rather than red. The
 * constraints it leans on are asserted before it trusts any of them.
 */
export function schemaIdentityProblems(schema: JsonSchema): string[] {
  const problems: string[] = []
  if (schema.$id !== PORTABLE_SCHEMA_URL) {
    problems.push(`plugin.schema.json: $id is ${JSON.stringify(schema.$id)}, expected ${PORTABLE_SCHEMA_URL}`)
  }
  if (schema.additionalProperties !== false) problems.push('plugin.schema.json: the root is no longer a closed schema')
  for (const field of ['$schema', 'name']) {
    if (!(schema.required ?? []).includes(field)) problems.push(`plugin.schema.json: "${field}" is no longer required`)
  }
  return problems
}

export async function assertPortableManifest(files: readonly RenderedFile[]): Promise<string[]> {
  const schema = JSON.parse(await readFile(join(repoRoot, TEMPLATE_DIR, 'plugin.schema.json'), 'utf8')) as JsonSchema
  const identity = schemaIdentityProblems(schema)
  if (identity.length > 0) return identity
  const file = files.find((f) => f.path === 'plugins/guren/plugin.json')
  if (!file) return ['plugins/guren/plugin.json was not rendered']
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(file.content) as Record<string, unknown>
  } catch (error) {
    return [`plugins/guren/plugin.json is not valid JSON: ${(error as Error).message}`]
  }
  const problems = validateAgainstSchema(manifest, schema)
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
 * Does this changeset's frontmatter release `pkg`? Only the `---` block is read,
 * through `core-semver-audit.ts`'s parser rather than a second regex: two
 * readings of one file format is how the two gates come to disagree.
 *
 * Throws on a changeset it cannot read rather than reporting "no release for
 * pkg", since an unparseable changeset is not evidence none was planned.
 */
export function changesetNames(source: string, pkg: string, file = 'changeset'): boolean {
  return parseChangeset(file, source).releases.has(pkg)
}

/**
 * Sources changed ⇒ a `@guren/cli` changeset is present, unless the CLI version
 * itself moved. Compared against `base` (a ref or SHA), which callers on shallow
 * checkouts must fetch first. `repo` is the checkout to run in: the gate is only
 * observable against real commits, so its tests build throwaway repositories.
 */
export async function assertChangesetGate(base: string, repo: string = repoRoot): Promise<string[]> {
  // Merge-base is the precise left side, but a shallow CI checkout that fetched
  // only the base SHA has none, so it falls back to the base tip. Resolved to one
  // rev rather than two diff spellings, because the version comparison below must
  // read the same side the file list came from: on a stale branch the base tip can
  // carry a *newer* version than HEAD and exempt a run the merge base would gate.
  // The fallback is safe for the two events CI passes a base for, both naming a
  // specific commit. Empty output counts as a failure, not a rev: an empty left
  // side makes `git diff ..HEAD` a diff of HEAD against itself, which reports no
  // files and passes this gate rather than reporting that it could not run.
  const mergeBase = Bun.spawnSync(['git', 'merge-base', base, 'HEAD'], { cwd: repo })
  const diffBase = (mergeBase.success && mergeBase.stdout.toString().trim()) || base
  const diff = Bun.spawnSync(['git', 'diff', '--name-only', `${diffBase}..HEAD`], { cwd: repo })
  if (!diff.success) {
    return [`could not diff against ${base}: ${diff.stderr.toString().trim()} — fetch the base ref before running --check`]
  }
  const changed = diff.stdout.toString().split('\n').filter(Boolean)
  const touched = changed.filter((f) => CATALOG_INPUTS.some((input) => (input.endsWith('/') ? f.startsWith(input) : f === input)))
  if (touched.length === 0) return []

  // The version moved ⇒ exempt: the harm named here is a payload published under
  // an *unchanged* version, so `changeset version`'s own commit is green whatever
  // rides with it. Note the direction: an exemption keyed on the version, never a
  // demand that a PR move one (RFC 0011 §5). A manifest edit that leaves the
  // version alone is still gated.
  //
  // The head side is the working tree, so a `--check` run part-way through
  // `changeset version` is judged on what a publish from that checkout would
  // carry; the price is that a step rewriting the manifest without committing it
  // could manufacture an exemption. Read off disk rather than through
  // `readContext()`, so GUREN_CATALOG_VERSION_OVERRIDE cannot manufacture one.
  //
  // Compared as strings: `compareVersions` returns NaN for an inexact version and
  // orders `1.0.0+build` equal to `1.0.0`, two spellings that publish as two
  // different payload versions.
  const baseVersion = versionOf(manifestAtRev(diffBase, CLI_MANIFEST, repo))
  const headVersion = versionOf(await readFile(join(repo, CLI_MANIFEST), 'utf8').catch(() => undefined))
  if (baseVersion !== undefined && headVersion !== undefined && baseVersion !== headVersion) return []
  // A side that could not be read is not an exemption; it falls through to the
  // changeset check, so a PR that has one still passes and the reason is reported
  // only when it does not.

  const changesetDir = join(repo, '.changeset')
  let names: string[] = []
  try {
    names = (await readdir(changesetDir)).filter((n) => n.endsWith('.md') && n !== 'README.md')
  } catch {
    // no .changeset dir — fall through to the failure below
  }
  for (const name of names) {
    try {
      if (changesetNames(await readFile(join(changesetDir, name), 'utf8'), '@guren/cli', name)) return []
    } catch (error) {
      // an unreadable changeset is not evidence that no release was planned
      return [`could not read .changeset/${name}: ${error instanceof Error ? error.message : String(error)}`]
    }
  }
  const unreadable = [
    baseVersion === undefined ? `the base side (${diffBase})` : undefined,
    headVersion === undefined ? 'the working tree' : undefined,
  ].filter(Boolean)
  return [
    `catalog inputs changed (${touched.join(', ')}) but no .changeset/*.md names "@guren/cli". ` +
      'The plugin version is the CLI version and a payload published under an unchanged version is one every installed copy skips forever; add a @guren/cli changeset.' +
      (unreadable.length > 0
        ? ` The @guren/cli version could not be read on ${unreadable.join(' or ')}, so the version-moved exemption could not be evaluated.`
        : ''),
  ]
}

/**
 * `claude plugin validate --strict`, the same check the community-marketplace
 * review pipeline runs; verified to need no authentication (2026-08-18). Keeps
 * `unavailable` (no `claude` on PATH) distinct from `fail`: the caller decides
 * whether to block, but it is never reported as pass.
 */
export type ValidateOutcome = { kind: 'pass' } | { kind: 'fail'; output: string } | { kind: 'unavailable'; reason: string }

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

/**
 * The derived-fact rules as one call, run by both `--check` and the publish
 * script over the tree they are about to trust, so the two cannot diverge.
 */
export async function auditRenderedFiles(files: readonly RenderedFile[]): Promise<string[]> {
  return [
    ...(await assertCommandsAndFlags(files)),
    ...assertTargets(files),
    ...(await assertMinCli()),
    ...(await assertPortableManifest(files)),
  ]
}

/** 0 clean, 1 a rule failed, 2 the gate could not fully run. */
async function check(base: string | undefined, requireValidate: boolean): Promise<number> {
  const files = await renderCatalog()
  const problems = [
    ...(await auditRenderedFiles(files)),
    ...(base ? await assertChangesetGate(base) : []),
  ]
  if (problems.length > 0) {
    console.error(`agent-catalog audit failed:\n${problems.map((p) => `  ${p}`).join('\n')}`)
    return 1
  }

  // write the tree that was just audited, not a second render of it
  const dir = await mkdtemp(join(tmpdir(), 'guren-agent-catalog-'))
  let outcome: ValidateOutcome
  try {
    await writeCatalog(dir, files)
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

/**
 * Is what gurenjs/agent-skills publishes the same tree this checkout renders?
 * Read-only, and the nightly drift job's only defense against a forgotten
 * publish. Exit 1 on drift with the file list; exit 2 if the public repo could
 * not be cloned, since unavailable is not green.
 */
export async function diffPublished(remote: string): Promise<{ code: 0 | 1 | 2; report: string }> {
  const cloneDir = await mkdtemp(join(tmpdir(), 'guren-agent-catalog-published-'))
  try {
    // NO_HOOKS: a post-checkout hook writing into the fresh clone would read back
    // below as what the public repository publishes
    const clone = Bun.spawnSync(['git', ...NO_HOOKS, 'clone', '--quiet', '--depth', '1', remote, cloneDir])
    if (!clone.success) {
      return { code: 2, report: `could not clone ${remote}:\n${clone.stderr.toString().trim()}` }
    }
    const rendered = await renderCatalog()
    const drift: string[] = []
    for (const file of rendered) {
      const published = Bun.file(join(cloneDir, file.path))
      if (!(await published.exists())) {
        drift.push(`missing in published: ${file.path}`)
        continue
      }
      if ((await published.text()) !== file.content) {
        drift.push(`differs: ${file.path}`)
      }
    }
    // files the publish would delete
    const tracked = Bun.spawnSync(['git', 'ls-files'], { cwd: cloneDir }).stdout.toString().split('\n').filter(Boolean)
    const renderedPaths = new Set(rendered.map((f) => f.path))
    for (const path of tracked) {
      if (!renderedPaths.has(path)) drift.push(`extra in published: ${path}`)
    }
    if (drift.length === 0) {
      return { code: 0, report: `gurenjs/agent-skills matches this checkout's render (${rendered.length} files).` }
    }
    return {
      code: 1,
      report:
        `gurenjs/agent-skills has drifted from this checkout's render:\n${drift.map((d) => `  ${d}`).join('\n')}\n` +
        'Run `bun run publish:agent-catalog` after the release that carries these sources.',
    }
  } finally {
    await rm(cloneDir, { recursive: true, force: true })
  }
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
  if (args.includes('--diff-published')) {
    const remote = process.env.GUREN_AGENT_SKILLS_REMOTE ?? 'https://github.com/gurenjs/agent-skills.git'
    const result = await diffPublished(remote)
    ;(result.code === 0 ? console.log : console.error)(result.report)
    process.exitCode = result.code
    return
  }
  const outDir = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1]! : undefined
  if (!outDir) {
    throw new Error('Usage: build-agent-catalog.ts --out <dir> | --check [--base <ref>] [--require-validate] | --diff-published')
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
