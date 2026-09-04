// No workspace-internal code may invoke the CLI as `bunx guren` (or `bun x
// guren` / `npx guren`): the `guren` package does not exist on npm, so
// whenever the workspace link is missing the runner falls back to the
// registry and dies on a 404. Run the source: `bun …/packages/cli/src/bin.ts`.
//
// Three scopes: package.json scripts (root manifest + every workspace member),
// TypeScript under scripts/, and shell scripts under scripts/. A smoke's
// `['bunx', 'guren', …]` argv is invisible to a manifest-only scan and passes
// locally anyway, because the temp app it builds gets a `.bin/guren` from its
// `file:` link to packages/cli — exactly the link CI cannot be trusted to
// have. Template trees are none of the three, and `bunx guren` is *correct*
// there: scaffolded apps install @guren/cli from npm and get a real bin.
//
// Deliberately not chased, since it would trade a bounded honest-mistake
// detector for an unbounded obfuscation-resistant one: a runner reached
// through an import alias or a local rebinding, and shell quoting inside a
// command string. No script in this repo writes the CLI that way today.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { parse } from '@babel/parser'
import * as t from '@babel/types'

import { literalString, unwrapTypeAssertion, walk } from '../../packages/cli/src/ast-walk'

const repoRoot = resolve(import.meta.dir, '../..')

// The registry-resolving spellings of the CLI, as token sequences rather than a
// regex: "skip N flag tokens" backtracks exponentially on pathological input
// (CodeQL flagged exactly this), while a token scan is linear.
const RUNNER_TOKEN_SEQUENCES: readonly (readonly string[])[] = [
  ['bunx'],
  ['bun', 'x'],
  ['npx'],
  ['npm', 'exec'],
  ['pnpm', 'dlx'],
  ['pnpm', 'exec'],
  ['yarn', 'dlx'],
  ['yarn', 'exec'],
]

function isGurenTarget(token: string): boolean {
  return token === 'guren' || token.startsWith('guren@')
}

/**
 * Whether an already-tokenized command resolves `guren` through a registry
 * runner. Tokens are compared whole: an argv element `'bunx guren'` is one
 * token that equals neither `bunx` nor `guren`, which is what keeps a
 * mention list (`['bunx guren add auth', …]`) from reading as an invocation.
 */
export function tokensInvokeRegistryGuren(tokens: readonly string[]): boolean {
  for (let i = 0; i < tokens.length; i++) {
    for (const sequence of RUNNER_TOKEN_SEQUENCES) {
      if (!sequence.every((expected, offset) => tokens[i + offset] === expected)) continue
      let next = i + sequence.length
      while (next < tokens.length && tokens[next].startsWith('-')) next++
      if (next < tokens.length && isGurenTarget(tokens[next])) return true
    }
  }
  return false
}

export function invokesRegistryGuren(command: string): boolean {
  return tokensInvokeRegistryGuren(command.split(/\s+/).filter(Boolean))
}

// The sanctioned replacement, when spelled dot-relative. Cwd-shifting forms
// cannot be resolved statically and are left to the negative check above.
const RELATIVE_CLI_PATH = /\bbun\s+((?:\.\.?\/)\S*packages\/cli\/src\/bin\.ts)\b/g

interface Manifest {
  workspaces?: string[]
  scripts?: Record<string, string>
}

export interface Violation {
  /** Repo-relative path of the manifest or source file. */
  file: string
  /** `"script-name"` in a manifest, `line:col` in TypeScript, `line N` in shell. */
  where: string
  problem: string
}

export function collectManifestViolations(manifestPath: string, manifest: Manifest): Violation[] {
  const violations: Violation[] = []
  for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
    if (invokesRegistryGuren(command)) {
      violations.push({
        file: manifestPath,
        where: `"${script}"`,
        problem: `resolves \`guren\` from the registry: ${command}`,
      })
    }
    for (const [, cliPath] of command.matchAll(RELATIVE_CLI_PATH)) {
      if (!existsSync(resolve(repoRoot, dirname(manifestPath), cliPath))) {
        violations.push({
          file: manifestPath,
          where: `"${script}"`,
          problem: `points at a CLI entry that does not exist from this directory: ${cliPath}`,
        })
      }
    }
  }
  return violations
}

// Callees whose first argument is a shell command string: `exec('bunx guren …')`.
const SHELL_STRING_CALLEES = new Set(['exec', 'execSync'])
// Callees taking (file, args[]): `spawn('bunx', ['guren', …])`.
const FILE_ARGS_CALLEES = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync'])

/**
 * A template's text with every `${…}` hole replaced by a token that can match
 * nothing — the surrounding literal tokens are still the command.
 */
function templateText(node: t.TemplateLiteral): string {
  return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' <expr> ')
}

/**
 * Under Bun `process.execPath` is the running `bun` binary, so
 * `[process.execPath, 'x', 'guren']` is `bunx guren` exactly as much as
 * `['bun', 'x', 'guren']` is — and it is already how this repo's own scripts
 * (test-packages.ts, build-packages.ts, …) spawn `bun` with fresh arguments.
 */
function isProcessExecPath(node: t.Node | null | undefined): boolean {
  if (!node) return false
  const unwrapped = unwrapTypeAssertion(node)
  return (
    t.isMemberExpression(unwrapped) &&
    !unwrapped.computed &&
    t.isIdentifier(unwrapped.object, { name: 'process' }) &&
    t.isIdentifier(unwrapped.property, { name: 'execPath' })
  )
}

function argvToken(node: t.Node | null | undefined): string | null {
  return isProcessExecPath(node) ? 'bun' : literalString(node)
}

function leadingArgv(node: t.ArrayExpression): string[] {
  const tokens: string[] = []
  for (const element of node.elements) {
    const text = argvToken(element)
    if (text === null) break
    tokens.push(text)
  }
  return tokens
}

function calleeName(callee: t.Node): string | null {
  if (t.isIdentifier(callee)) return callee.name
  if (t.isMemberExpression(callee) && t.isIdentifier(callee.property)) return callee.property.name
  return null
}

function position(node: t.Node): string {
  return node.loc ? `${node.loc.start.line}:${node.loc.start.column + 1}` : '?'
}

/**
 * Registry-resolving `guren` invocations in one TypeScript source, judged by
 * spawn shape. Exported for the test; `file` is only used to label findings.
 */
export function collectSourceViolations(file: string, source: string): Violation[] {
  // A parse error throws: a source this scan cannot read is a source it
  // cannot clear, and an unavailable check is not a green one.
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })

  const violations: Violation[] = []
  const flag = (node: t.Node, shape: string, command: string) => {
    violations.push({
      file,
      where: position(node),
      problem: `${shape} resolves \`guren\` from the registry: ${command}`,
    })
  }

  walk(ast, (visited) => {
    const node = visited as unknown as t.Node

    if (t.isArrayExpression(node)) {
      const argv = leadingArgv(node)
      if (tokensInvokeRegistryGuren(argv)) flag(node, 'argv array', argv.join(' '))
      return
    }

    if (t.isTaggedTemplateExpression(node) && calleeName(node.tag) === '$') {
      const command = templateText(node.quasi)
      if (invokesRegistryGuren(command)) flag(node, 'shell template', command.trim())
      return
    }

    if (!t.isCallExpression(node)) return
    const name = calleeName(node.callee)
    if (!name) return
    const [first, second] = node.arguments

    if (SHELL_STRING_CALLEES.has(name)) {
      const command = t.isTemplateLiteral(first) ? templateText(first) : literalString(first)
      if (command !== null && invokesRegistryGuren(command)) flag(node, `${name}()`, command.trim())
      return
    }

    if (!FILE_ARGS_CALLEES.has(name)) return
    const fileToken = argvToken(first)
    if (fileToken === null) return
    const args = t.isArrayExpression(second) ? leadingArgv(second) : []
    const tokens = [fileToken, ...args]
    // `spawn(cmd, { shell: true })` runs its first argument as a whole command
    // line rather than argv[0]. Checking it as a string too is free: a bare
    // `'bunx'` token cannot match without `guren` in that same string.
    if (tokensInvokeRegistryGuren(tokens) || invokesRegistryGuren(fileToken)) {
      flag(node, `${name}()`, tokens.join(' '))
    }
  })

  return violations
}

/**
 * Registry-resolving `guren` invocations in one shell script, judged per line.
 * Full-line comments are skipped for the reason a TypeScript mention passes:
 * documenting the forbidden spelling is not running it.
 */
export function collectShellViolations(file: string, source: string): Violation[] {
  const violations: Violation[] = []
  source.split('\n').forEach((line, index) => {
    if (line.trimStart().startsWith('#')) return
    if (!invokesRegistryGuren(line)) return
    violations.push({
      file,
      where: `line ${index + 1}`,
      problem: `resolves \`guren\` from the registry: ${line.trim()}`,
    })
  })
  return violations
}

const SOURCE_SCAN_GLOB = 'scripts/**/*.ts'
const SHELL_SCAN_GLOB = 'scripts/**/*.sh'

function globFiles(pattern: string): string[] {
  return [...new Bun.Glob(pattern).scanSync({ cwd: repoRoot })].sort()
}

export function collectSourceFiles(): string[] {
  return globFiles(SOURCE_SCAN_GLOB)
}

async function main(): Promise<void> {
  const rootManifest = (await Bun.file(join(repoRoot, 'package.json')).json()) as Manifest
  if (!Array.isArray(rootManifest.workspaces) || rootManifest.workspaces.length === 0) {
    throw new Error('Root package.json declares no workspaces — audit scope would be empty.')
  }

  const memberManifestPaths = rootManifest.workspaces
    .flatMap((pattern) => globFiles(`${pattern}/package.json`))
    .sort()

  if (memberManifestPaths.length === 0) {
    throw new Error('No workspace members resolved — the workspaces globs no longer match this audit.')
  }

  const violations = collectManifestViolations('package.json', rootManifest)
  for (const manifestPath of memberManifestPaths) {
    const manifest = (await Bun.file(join(repoRoot, manifestPath)).json()) as Manifest
    violations.push(...collectManifestViolations(manifestPath, manifest))
  }

  const sourceFiles = collectSourceFiles()
  if (sourceFiles.length === 0) {
    throw new Error(`No sources matched ${SOURCE_SCAN_GLOB} — the source scan scope would be empty.`)
  }
  for (const file of sourceFiles) {
    violations.push(...collectSourceViolations(file, await Bun.file(join(repoRoot, file)).text()))
  }

  // No emptiness guard here, unlike the two scans above: scripts/ holding no
  // shell script is a plausible state rather than a broken glob, so the count
  // is reported instead of asserted.
  const shellFiles = globFiles(SHELL_SCAN_GLOB)
  for (const file of shellFiles) {
    violations.push(...collectShellViolations(file, await Bun.file(join(repoRoot, file)).text()))
  }

  if (violations.length > 0) {
    console.error('Workspace scripts audit failed: `guren` is not published to npm, so workspace code must run packages/cli/src/bin.ts directly — and through a path that resolves.')
    for (const { file, where, problem } of violations) {
      console.error(`  ${file} → ${where} ${problem}`)
    }
    console.error('Fix: run the CLI source directly, e.g. `bun ../../packages/cli/src/bin.ts <command>` in a manifest (adjust the relative path to the member directory), or `[\'bun\', resolve(repoRoot, \'packages/cli/src/bin.ts\'), …]` in a script.')
    process.exit(1)
  }

  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
  console.log(
    `Workspace scripts audit passed: ${plural(memberManifestPaths.length, 'workspace member')} + root manifest, ` +
      `${plural(sourceFiles.length, 'scripts/ source')} and ${plural(shellFiles.length, 'shell script')} invoke the CLI locally.`,
  )
}

if (import.meta.main) {
  await main()
}
