// Asserts that nothing workspace-internal invokes the CLI as `bunx guren`
// (or `bun x guren` / `npx guren`).
//
// The `guren` package does not exist on npm. Inside this checkout the CLI is
// only reachable through the workspace link (`node_modules/.bin/guren`), and
// whenever that link is missing — fresh clone, partial install, CI cache — the
// runner falls back to the registry and dies on a 404. Workspace code must run
// the CLI source directly: `bun <path-to>/packages/cli/src/bin.ts`.
//
// Two scopes, because the rule has two ways of being broken:
//
//   1. package.json scripts — the root manifest plus every workspace member
//      resolved from the root `workspaces` globs.
//   2. TypeScript under scripts/ — the smokes and gates spawn commands
//      themselves, and a `['bunx', 'guren', …]` argv there is invisible to a
//      manifest-only audit. It even passes locally, because the temp app a
//      smoke builds gets a `.bin/guren` from its `file:` link to
//      packages/cli, which is exactly the link CI cannot be trusted to have.
//
// Template trees (`packages/create-app/templates/**`, `packages/cli/templates/**`)
// are structurally out of scope — they are not workspace members and not
// under scripts/ — and `bunx guren` is *correct* there, because scaffolded
// apps install @guren/cli from npm and get a real `node_modules/.bin/guren`.
//
// The source scan judges *spawn shapes*, not text: an argv array whose
// elements are the tokens, a Bun shell `$` template, or a string handed to
// `exec`/`spawn` and friends. A string that merely mentions `bunx guren` — a
// docs audit asserting a guide documents it, a test of a docs checker — is
// a mention, not an invocation, and is left alone.

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { parse } from '@babel/parser'
import * as t from '@babel/types'

const repoRoot = resolve(import.meta.dir, '../..')

// `bunx guren`, `bunx --bun guren`, `bun x guren`, `npx guren`, `pnpm dlx
// guren`, `guren@…` — the registry-resolving spellings of the CLI, as token
// sequences rather than a regex: a run of `--flag`/`-f` tokens between the
// runner and `guren` is unbounded and package-manager flags are unbounded
// too, and a regex expressing "skip N flag tokens" backtracks exponentially
// on pathological input (CodeQL flagged exactly this). A token scan is
// linear by construction.
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

/** Whether a shell command string resolves `guren` through a registry runner. */
export function invokesRegistryGuren(command: string): boolean {
  return tokensInvokeRegistryGuren(command.split(/\s+/).filter(Boolean))
}

// The sanctioned replacement, when spelled dot-relative. Cwd-shifting forms
// (`cd .. && bun packages/cli/src/bin.ts …`) can't be resolved statically and
// are left to the negative check above.
const RELATIVE_CLI_PATH = /\bbun\s+((?:\.\.?\/)\S*packages\/cli\/src\/bin\.ts)\b/g

interface Manifest {
  workspaces?: string[]
  scripts?: Record<string, string>
}

export interface Violation {
  /** Repo-relative path of the manifest or source file. */
  file: string
  /** `"script-name"` for a manifest, `line:col` for a source file. */
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

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

// Callees whose first argument is a shell command string: `exec('bunx guren …')`.
const SHELL_STRING_CALLEES = new Set(['exec', 'execSync'])
// Callees taking (file, args[]): `spawn('bunx', ['guren', …])`.
const FILE_ARGS_CALLEES = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync'])

/** A string-valued literal's text, or null when it is dynamic. */
function literalText(node: t.Node | null | undefined): string | null {
  if (!node) return null
  if (t.isStringLiteral(node)) return node.value
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('')
  }
  return null
}

/**
 * A template's text with every `${…}` hole replaced by a token that can match
 * nothing — the surrounding literal tokens are still the command.
 */
function templateText(node: t.TemplateLiteral): string {
  return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(' <expr> ')
}

/** Leading string-literal elements of an argv array, one token each. */
function leadingArgv(node: t.ArrayExpression): string[] {
  const tokens: string[] = []
  for (const element of node.elements) {
    const text = literalText(element)
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

function isShellTag(tag: t.Node): boolean {
  return calleeName(tag) === '$'
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

  const visit = (node: t.Node): void => {
    if (t.isArrayExpression(node)) {
      const argv = leadingArgv(node)
      if (tokensInvokeRegistryGuren(argv)) flag(node, 'argv array', argv.join(' '))
    } else if (t.isTaggedTemplateExpression(node) && isShellTag(node.tag)) {
      const command = templateText(node.quasi)
      if (invokesRegistryGuren(command)) flag(node, 'shell template', command.trim())
    } else if (t.isCallExpression(node)) {
      const name = calleeName(node.callee)
      const [first, second] = node.arguments
      if (name && SHELL_STRING_CALLEES.has(name)) {
        const command = t.isTemplateLiteral(first) ? templateText(first) : literalText(first)
        if (command !== null && invokesRegistryGuren(command)) flag(node, `${name}()`, command.trim())
      } else if (name && FILE_ARGS_CALLEES.has(name)) {
        const fileToken = literalText(first)
        if (fileToken !== null) {
          const args = t.isArrayExpression(second) ? leadingArgv(second) : []
          const tokens = [fileToken, ...args]
          if (tokensInvokeRegistryGuren(tokens)) flag(node, `${name}()`, tokens.join(' '))
        }
      }
    }

    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, unknown>)[key]
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof (item as t.Node).type === 'string') visit(item as t.Node)
      } else if (child && typeof (child as t.Node).type === 'string') {
        visit(child as t.Node)
      }
    }
  }

  visit(ast)
  return violations
}

export const SOURCE_SCAN_GLOB = 'scripts/**/*.ts'

export async function collectSourceFiles(): Promise<string[]> {
  const files: string[] = []
  for await (const path of new Bun.Glob(SOURCE_SCAN_GLOB).scan({ cwd: repoRoot })) {
    files.push(path)
  }
  return files.sort()
}

async function main(): Promise<void> {
  const rootManifest = (await Bun.file(join(repoRoot, 'package.json')).json()) as Manifest
  if (!Array.isArray(rootManifest.workspaces) || rootManifest.workspaces.length === 0) {
    throw new Error('Root package.json declares no workspaces — audit scope would be empty.')
  }

  const memberManifestPaths: string[] = []
  for (const pattern of rootManifest.workspaces) {
    const glob = new Bun.Glob(`${pattern}/package.json`)
    for await (const path of glob.scan({ cwd: repoRoot })) {
      memberManifestPaths.push(path)
    }
  }
  memberManifestPaths.sort()

  if (memberManifestPaths.length === 0) {
    throw new Error('No workspace members resolved — the workspaces globs no longer match this audit.')
  }

  const violations = collectManifestViolations('package.json', rootManifest)
  for (const manifestPath of memberManifestPaths) {
    const manifest = (await Bun.file(join(repoRoot, manifestPath)).json()) as Manifest
    violations.push(...collectManifestViolations(manifestPath, manifest))
  }

  const sourceFiles = await collectSourceFiles()
  if (sourceFiles.length === 0) {
    throw new Error(`No sources matched ${SOURCE_SCAN_GLOB} — the source scan scope would be empty.`)
  }
  for (const file of sourceFiles) {
    violations.push(...collectSourceViolations(file, await readFile(join(repoRoot, file), 'utf8')))
  }

  if (violations.length > 0) {
    console.error('Workspace scripts audit failed: `guren` is not published to npm, so workspace code must run packages/cli/src/bin.ts directly — and through a path that resolves.')
    for (const { file, where, problem } of violations) {
      console.error(`  ${file} → ${where} ${problem}`)
    }
    console.error('Fix: run the CLI source directly, e.g. `bun ../../packages/cli/src/bin.ts <command>` in a manifest (adjust the relative path to the member directory), or `[\'bun\', resolve(repoRoot, \'packages/cli/src/bin.ts\'), …]` in a script.')
    process.exit(1)
  }

  console.log(`Workspace scripts audit passed: ${memberManifestPaths.length} workspace members + root manifest and ${sourceFiles.length} scripts/ sources invoke the CLI locally.`)
}

if (import.meta.main) {
  await main()
}
