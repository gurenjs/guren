#!/usr/bin/env bun
/**
 * The machine-checkable half of the comment rules in
 * .claude/rules/coding-standards.md: block length, banners, step labels,
 * change-history wording, and `@param` tags that restate the name. Whether a
 * comment narrates the code stays a review judgment. Ratcheted: a file fails
 * only when a rule's count grew against its base version, so the legacy
 * backlog never blocks a PR that leaves it alone. Comments come from
 * `@babel/parser`, so template-literal contents are never inspected.
 */
import { parse } from '@babel/parser'
import { readFileSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'

export type Rule = 'long-block' | 'banner' | 'step-label' | 'history' | 'param-restates'

export interface Finding {
  file: string
  line: number
  rule: Rule
  message: string
  /** Stable identity for the ratchet: rule plus the block's normalized text. */
  key: string
}

export const LIMITS = { body: 5, moduleHeader: 8 } as const

/** Paths never linted: generated output, vendored trees, scaffold templates, fixtures. */
export const SKIP_PATH =
  /(^|\/)(node_modules|dist|\.guren|coverage|fixtures|stubs)\/|\.gen\.|\.d\.ts$|^packages\/(cli|create-app)\/templates\//

/** A comment carrying any of these is tooling input or policy-required, never a finding. */
const PROTECTED =
  /@ts-|eslint|prettier-ignore|c8 ignore|istanbul ignore|@vite-ignore|webpackChunkName|__PURE__|@docs\b|@deprecated\b|@jsxImportSource|@vitest-environment|<reference\s|guren-audit-ignore|comment-lint-ignore/

const HISTORY =
  /\b(used to|previously|formerly|originally|was changed|has been changed|before this (change|pr|commit)|no longer)\b/i
const BANNER = /^\s*[-=─═*#]{3,}\s*(\S.*)?$/
const STEP = /^\s*step\s*\d+\b/i
const PARAM_RESTATES = /@param\s+(?:\{[^}]*\}\s+)?(\w+)\s*(?:-\s*)?(?:the\s+|a\s+|an\s+)?(\w+)\s*$/gim

interface Block {
  line: number
  endLine: number
  /** Text with comment syntax stripped, one entry per line. */
  lines: string[]
  bodyLines: number
  trailing: boolean
  isModuleHeader: boolean
  raw: string
}

function stripLine(text: string): string {
  return text.replace(/^\s*\/\/\s?/, '').replace(/^\s*\*\s?/, '').trimEnd()
}

/** Group babel's comments into the blocks a reader sees: a JSDoc, or a run of adjacent `//` lines. */
export function collectBlocks(source: string, file: string): Block[] {
  const plugins: Parameters<typeof parse>[1] extends { plugins?: infer P } ? P : never = ['typescript', 'decorators-legacy']
  if (/\.(tsx|jsx)$/.test(file)) plugins!.push('jsx')
  let comments: Array<{ type: string; value: string; loc: { start: { line: number; column: number }; end: { line: number } } }>
  let firstStatementLine = Number.POSITIVE_INFINITY
  try {
    const ast = parse(source, { sourceType: 'module', plugins, errorRecovery: true, attachComment: false })
    comments = (ast.comments ?? []) as typeof comments
    const first = ast.program.body[0] ?? ast.program.directives?.[0]
    if (first?.loc) firstStatementLine = first.loc.start.line
  } catch {
    return []
  }
  const sourceLines = source.split('\n')
  const blocks: Block[] = []
  let run: Block | null = null
  for (const c of comments) {
    const prefix = sourceLines[c.loc.start.line - 1]?.slice(0, c.loc.start.column) ?? ''
    const trailing = prefix.trim().length > 0
    if (c.type === 'CommentLine') {
      const text = stripLine(`//${c.value}`)
      if (!trailing && run && run.endLine === c.loc.start.line - 1) {
        run.lines.push(text)
        run.endLine = c.loc.start.line
        run.bodyLines++
        run.raw += `\n${c.value}`
        continue
      }
      run = {
        line: c.loc.start.line,
        endLine: c.loc.start.line,
        lines: [text],
        bodyLines: 1,
        trailing,
        isModuleHeader: false,
        raw: c.value,
      }
      blocks.push(run)
      continue
    }
    run = null
    const rawLines = c.value.split('\n')
    const inner = rawLines.map((l) => stripLine(l.startsWith('*') ? l : `*${l}`))
    const isDoc = rawLines.length > 1
    const bodyLines = isDoc ? rawLines.length - 1 - (rawLines.at(-1)!.trim() === '' ? 1 : 0) - (rawLines[0].trim() === '*' || rawLines[0].trim() === '' ? 1 : 0) + 1 : 1
    blocks.push({
      line: c.loc.start.line,
      endLine: c.loc.end.line,
      lines: inner.filter((_, i) => !(i === 0 && rawLines[0].trim() === '*') && !(i === rawLines.length - 1 && rawLines.at(-1)!.trim() === '')),
      bodyLines: Math.max(1, bodyLines),
      trailing,
      isModuleHeader: false,
      raw: c.value,
    })
  }
  const header = blocks.find((b) => !b.trailing)
  if (header && header.line < firstStatementLine && header.line <= 3) header.isModuleHeader = true
  return blocks
}

export function lintSource(source: string, file: string): Finding[] {
  const findings: Finding[] = []
  for (const b of collectBlocks(source, file)) {
    if (PROTECTED.test(b.raw)) continue
    const text = b.lines.join('\n')
    const key = (rule: Rule) => `${rule}:${text.replace(/\s+/g, ' ').trim().slice(0, 80)}`
    const push = (rule: Rule, message: string, line = b.line) => findings.push({ file, line, rule, message, key: key(rule) })

    const limit = b.isModuleHeader ? LIMITS.moduleHeader : LIMITS.body
    if (!b.trailing && b.bodyLines > limit) {
      push('long-block', `${b.bodyLines}-line comment; keep to ${limit} (module header ${LIMITS.moduleHeader}) by dropping restatement and history, one fact per line`)
    }
    if (b.lines.length === 1 && BANNER.test(b.lines[0])) {
      push('banner', 'section banner; delete it, the next declaration is the heading')
    } else if (b.lines.length === 1 && /^\s*[-=─═*#]{3,}\s*$/.test(b.lines[0])) {
      push('banner', 'section banner; delete it')
    }
    b.lines.forEach((l, i) => {
      if (STEP.test(l)) push('step-label', `"${l.trim()}" narrates the code; delete it or state the constraint`, b.line + i)
    })
    const history = text.match(HISTORY)
    if (history) push('history', `"${history[0]}" describes a change, which belongs in the commit message; state the present rule instead`)
    for (const m of text.matchAll(PARAM_RESTATES)) {
      if (m[1].toLowerCase() === m[2].toLowerCase()) push('param-restates', `@param ${m[1]} only repeats its name; delete the tag or say what the value must satisfy`)
    }
  }
  return findings
}

export function newFindings(base: Finding[], head: Finding[]): Finding[] {
  const baseKeys = new Map<string, number>()
  for (const f of base) baseKeys.set(f.key, (baseKeys.get(f.key) ?? 0) + 1)
  const out: Finding[] = []
  for (const f of head) {
    const left = baseKeys.get(f.key) ?? 0
    if (left > 0) baseKeys.set(f.key, left - 1)
    else out.push(f)
  }
  return out
}

const repoRoot = resolve(import.meta.dir, '..')

function git(args: string[], cwd = repoRoot): { ok: boolean; out: string } {
  const r = Bun.spawnSync(['git', ...args], { cwd })
  return { ok: r.success, out: r.stdout.toString() }
}

function isLintable(file: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs)$/.test(file) && !SKIP_PATH.test(file)
}

function sourceAt(rev: string | undefined, file: string, cwd: string): string | undefined {
  if (rev === undefined) {
    try {
      return readFileSync(resolve(cwd, file), 'utf8')
    } catch {
      return undefined
    }
  }
  const r = git(['show', `${rev}:${file}`], cwd)
  return r.ok ? r.out : undefined
}

/**
 * Findings in `file` at `head` (a rev, or the working tree when undefined) that
 * its `base` version did not have. No base means every finding is new.
 */
export function lintFileRatcheted(file: string, base: string | undefined, head: string | undefined, cwd = repoRoot): Finding[] {
  const headSource = sourceAt(head, file, cwd)
  if (headSource === undefined) return []
  const headFindings = lintSource(headSource, file)
  if (base === undefined) return headFindings
  const baseSource = sourceAt(base, file, cwd)
  return baseSource === undefined ? headFindings : newFindings(lintSource(baseSource, file), headFindings)
}

export function resolveBase(base: string | undefined, cwd = repoRoot): string | undefined {
  const candidates = base ? [base] : ['origin/main', 'main']
  for (const c of candidates) {
    const mb = git(['merge-base', c, 'HEAD'], cwd)
    if (mb.ok && mb.out.trim()) return mb.out.trim()
    if (git(['rev-parse', '--verify', `${c}^{commit}`], cwd).ok) return c
  }
  return undefined
}

/** Files that differ between `base` and `head` (the working tree plus untracked files when head is undefined). */
export function changedFiles(base: string, head: string | undefined, cwd = repoRoot): string[] {
  const lines = head === undefined
    ? [...git(['diff', '--name-only', base], cwd).out.split('\n'), ...git(['ls-files', '--others', '--exclude-standard'], cwd).out.split('\n')]
    : git(['diff', '--name-only', base, head], cwd).out.split('\n')
  return lines.map((l) => l.trim()).filter(Boolean)
}

function format(findings: Finding[]): string {
  return findings.map((f) => `${f.file}:${f.line}  ${f.rule}  ${f.message}`).join('\n')
}

const RULE_DOC = 'Rules: .claude/rules/coding-standards.md (Comments). A comment that must exceed the limit can carry `comment-lint-ignore` with the reason.'

function label(rev: string): string {
  return /^[0-9a-f]{40}$/.test(rev) ? rev.slice(0, 12) : rev
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.includes('--hook')) {
    let filePath = ''
    try {
      filePath = (JSON.parse(await Bun.stdin.text()) as { tool_input?: { file_path?: string } }).tool_input?.file_path ?? ''
    } catch {
      return 0
    }
    const rel = relative(repoRoot, filePath)
    if (!filePath || rel.startsWith('..') || !isLintable(rel)) return 0
    const findings = lintFileRatcheted(rel, 'HEAD', undefined)
    if (findings.length === 0) return 0
    console.error(`comment-lint: ${findings.length} new comment issue(s) in ${rel}:\n${format(findings)}\n${RULE_DOC}`)
    return 2
  }

  const all = args.includes('--all')
  const opt = (name: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const baseArg = opt('--base')
  // A committed head rev pins both the file list and the contents, so a CI run on
  // a synthetic merge commit judges the PR's own commits, not what main merged.
  const head = opt('--head')
  const explicit = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--base' && args[i - 1] !== '--head')

  let base: string | undefined
  let files: string[]
  if (all) {
    files = explicit.length ? explicit : git(['ls-files']).out.split('\n')
  } else {
    base = head ? baseArg : resolveBase(baseArg)
    if (!base) {
      console.error('comment-lint: could not resolve a base to ratchet against (pass --base <ref>, or fetch main)')
      return 1
    }
    files = explicit.length ? explicit : changedFiles(base, head)
  }
  files = files.map((f) => f.trim()).filter(isLintable)

  const findings = files.flatMap((f) => lintFileRatcheted(f, all ? undefined : base, head))
  if (findings.length === 0) {
    console.log(`comment-lint passed (${files.length} file(s)${base ? `, ratcheted against ${label(base)}` : ''}${head ? ` at ${label(head)}` : ''})`)
    return 0
  }
  console.error(format(findings))
  console.error(`\ncomment-lint: ${findings.length} ${all ? '' : 'new '}finding(s) in ${new Set(findings.map((f) => f.file)).size} file(s). ${RULE_DOC}`)
  return 1
}

if (import.meta.main) process.exit(await main())
