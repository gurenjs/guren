/**
 * The one grammar for executable fences in the tutorial chapters (RFC 0019 §3):
 * how `smoke:tutorial` reads a chapter as a script, what `audit:tutorial-blocks`
 * rejects, and what the locale-parity check compares. Attributes follow the
 * language token on the fence's info string; renderers (the site, GitHub) read
 * only the first token, so the markers are invisible to readers. Parsing never
 * throws: a malformed fence is an issue with a line number, so one bad block
 * reports every other one too.
 */
import { readdir } from 'node:fs/promises'

export interface BlockIssue {
  file: string
  line: number
  message: string
}

interface BlockBase {
  /** 1-based line of the opening fence. */
  line: number
  lang: string
  body: string
}

export interface IllustrativeBlock extends BlockBase {
  kind: 'illustrative'
}

/** `stop-background` is the reader stopping a server (Ctrl-C); its body is comments and never runs. */
export type RunMode = 'normal' | 'expect-fail' | 'background' | 'stop-background'

export interface RunBlock extends BlockBase {
  kind: 'run'
  mode: RunMode
  /** Stands in for the agent beat it follows; an agent-driven runner skips it. */
  fallback: boolean
}

export interface FileBlock extends BlockBase {
  kind: 'file'
  /** App-root-relative; validated by `validateFilePath`. */
  path: string
  fallback: boolean
}

export interface ManualBlock extends BlockBase {
  kind: 'manual'
}

export type TutorialBlock = IllustrativeBlock | RunBlock | FileBlock | ManualBlock
export type ExecutableBlock = RunBlock | FileBlock | ManualBlock

export interface ParsedChapter {
  file: string
  blocks: TutorialBlock[]
  issues: BlockIssue[]
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/u
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/u
// Chapters are files, so their order is their name: `01-zero-to-deployed.md`.
export const CHAPTER_FILE = /^\d{2}-[a-z0-9-]+\.md$/u

/** The chapter files of a tutorials directory, in course order. */
export async function chapterFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir)
  return entries.filter((name) => CHAPTER_FILE.test(name)).sort()
}

/**
 * Why a `file=` path is unusable, or null. Paths are written under a temp app
 * root by the smoke, so anything that could leave it is refused here rather
 * than at write time: absolute, `..`, backslashes, `~`, empty segments.
 */
export function validateFilePath(path: string): string | null {
  if (path.length === 0) return 'file= needs a path'
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path)) return `file= path must be relative to the app root: ${path}`
  if (path.includes('\\')) return `file= path must use forward slashes: ${path}`
  if (path.startsWith('~')) return `file= path must not start with ~: ${path}`
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return `file= path must not contain empty, "." or ".." segments: ${path}`
  }
  return null
}

function classify(lang: string, attrs: string[], base: BlockBase, file: string): { block: TutorialBlock; issue?: BlockIssue } {
  const issue = (message: string): { block: TutorialBlock; issue: BlockIssue } => ({
    block: { ...base, kind: 'illustrative' },
    issue: { file, line: base.line, message },
  })
  if (attrs.length === 0) return { block: { ...base, kind: 'illustrative' } }

  const set = new Set(attrs)
  if (set.size !== attrs.length) return issue(`duplicate attribute on fence: ${attrs.join(' ')}`)
  const fallback = set.delete('fallback')

  const fileAttr = attrs.find((attr) => attr.startsWith('file='))
  if (fileAttr) {
    set.delete(fileAttr)
    if (set.size > 0) return issue(`file= accepts only "fallback" beside it, got: ${[...set].join(' ')}`)
    const path = fileAttr.slice('file='.length)
    const pathIssue = validateFilePath(path)
    if (pathIssue) return issue(pathIssue)
    return { block: { ...base, kind: 'file', path, fallback } }
  }

  if (set.has('manual')) {
    set.delete('manual')
    if (set.size > 0 || fallback) return issue(`manual takes no other attribute, got: ${attrs.join(' ')}`)
    return { block: { ...base, kind: 'manual' } }
  }

  if (set.has('run')) {
    set.delete('run')
    if (lang !== 'bash') return issue(`run blocks are bash, got: ${lang}`)
    const expectFail = set.delete('expect-fail')
    const background = set.delete('background')
    const stop = set.delete('stop-background')
    if ([expectFail, background, stop].filter(Boolean).length > 1) {
      return issue(`run takes one of expect-fail, background, stop-background, got: ${attrs.join(' ')}`)
    }
    if (set.size > 0) return issue(`unknown run attribute: ${[...set].join(' ')}`)
    if (stop) {
      if (fallback) return issue('run stop-background takes no fallback')
      // The smoke never executes this body, so a command in it would be a step the reader types and nothing checks.
      if (base.body.split('\n').some((line) => line.trim() !== '' && !line.trim().startsWith('#'))) {
        return issue('run stop-background body must be comments only (the reader presses Ctrl-C; nothing runs)')
      }
    }
    const mode: RunMode = expectFail ? 'expect-fail' : background ? 'background' : stop ? 'stop-background' : 'normal'
    return { block: { ...base, kind: 'run', mode, fallback } }
  }

  return issue(`unknown fence attribute(s): ${attrs.join(' ')} (expected run, run expect-fail, run background, run stop-background, file=<path>, manual, with optional fallback)`)
}

/**
 * Every fenced block of a chapter, CommonMark fence rules: an opening fence of
 * N characters closes only on a fence of the same character at least N long,
 * so a four-backtick fence quoting three-backtick examples yields one block.
 */
export function parseTutorialBlocks(markdown: string, file = '<markdown>'): ParsedChapter {
  const lines = markdown.split('\n')
  const blocks: TutorialBlock[] = []
  const issues: BlockIssue[] = []
  let i = 0
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i])
    if (!open) {
      i++
      continue
    }
    const fence = open[1]
    const info = open[2].trim()
    const openLine = i + 1
    const body: string[] = []
    let closed = false
    i++
    while (i < lines.length) {
      const line = lines[i]
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        closed = true
        i++
        break
      }
      body.push(line)
      i++
    }
    if (!closed) {
      issues.push({ file, line: openLine, message: 'unterminated fence' })
    }
    const [lang = '', ...attrs] = info.split(/\s+/u).filter((token) => token.length > 0)
    const base: BlockBase = { line: openLine, lang, body: body.join('\n') }
    const { block, issue } = classify(lang, attrs, base, file)
    blocks.push(block)
    if (issue) issues.push(issue)
  }
  return { file, blocks, issues }
}

export function executableBlocks(blocks: readonly TutorialBlock[]): ExecutableBlock[] {
  return blocks.filter((block): block is ExecutableBlock => block.kind !== 'illustrative')
}

/**
 * One line per executable block, everything the smoke acts on and nothing
 * else: kind, mode, path, fallback, body. The locale check compares these, so
 * translated prose around a block never counts and a translated body does.
 */
export function executableSignature(block: ExecutableBlock): string {
  switch (block.kind) {
    case 'run':
      return `run ${block.mode}${block.fallback ? ' fallback' : ''}\n${block.body}`
    case 'file':
      return `file=${block.path}${block.fallback ? ' fallback' : ''}\n${block.body}`
    case 'manual':
      return `manual\n${block.body}`
  }
}

/**
 * Where two chapters' executable sequences diverge, as issues on the second
 * one; empty when they match. Reported at the first difference: after one
 * insertion every later pair differs, and that list would only hide the cause.
 */
export function compareExecutableSequences(
  reference: ParsedChapter,
  mirror: ParsedChapter,
): BlockIssue[] {
  const a = executableBlocks(reference.blocks)
  const b = executableBlocks(mirror.blocks)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i]
    const right = b[i]
    if (!left) {
      return [{ file: mirror.file, line: right.line, message: `extra executable block #${i + 1} (${right.kind}); ${reference.file} has ${a.length}` }]
    }
    if (!right) {
      return [{ file: mirror.file, line: 0, message: `missing executable block #${i + 1} (${left.kind} at ${reference.file}:${left.line}); ${mirror.file} has ${b.length}` }]
    }
    if (executableSignature(left) !== executableSignature(right)) {
      return [{
        file: mirror.file,
        line: right.line,
        message: `executable block #${i + 1} differs from ${reference.file}:${left.line} (code stays identical across locales; only prose translates)`,
      }]
    }
  }
  return []
}

/**
 * Servers the reader starts outlive their chapter, unlike the smoke's (each on
 * its own port, stopped at chapter end), so the course is read in order here.
 * The same command again is a chapter's "start it if you stopped it"; another
 * command while one runs takes the reader's port. `manual` blocks are not modelled.
 */
export function auditBackgroundLifecycle(chapters: readonly ParsedChapter[]): BlockIssue[] {
  const issues: BlockIssue[] = []
  let running: { file: string; line: number; command: string } | null = null
  for (const chapter of chapters) {
    for (const block of chapter.blocks) {
      if (block.kind !== 'run') continue
      if (block.mode === 'stop-background') {
        if (!running) {
          issues.push({ file: chapter.file, line: block.line, message: 'run stop-background with no background server running' })
        }
        running = null
        continue
      }
      if (block.mode !== 'background') continue
      const command = block.body.trim()
      if (running && running.command !== command) {
        issues.push({
          file: chapter.file,
          line: block.line,
          message: `\`${command}\` starts while \`${running.command}\` from ${running.file}:${running.line} is still running on the reader's port; add a \`bash run stop-background\` block before it`,
        })
      }
      running = { file: chapter.file, line: block.line, command }
    }
  }
  return issues
}

/** The directory a `run` block that is exactly `cd <dir>` moves the app root to, or null. */
export function cdTarget(body: string): string | null {
  const match = /^cd[ \t]+([^\s"'&|;<>]+)[ \t]*$/u.exec(body.trim())
  return match ? match[1] : null
}

export interface ScaffoldCommand {
  target: string
  flags: string[]
}

/**
 * A `run` block that is exactly one `bunx create-guren-app <target> [flags]`
 * line. The smoke swaps this one command for the checkout's scaffolder (RFC
 * 0019 §3, the single substitution it makes); every flag passes through, so
 * the interactive and CI paths scaffold the same app.
 */
export function parseScaffoldCommand(body: string): ScaffoldCommand | null {
  const tokens = body.trim().split(/\s+/u)
  if (tokens.length < 3 || tokens[0] !== 'bunx' || tokens[1] !== 'create-guren-app') return null
  if (body.trim().includes('\n')) return null
  const [target, ...flags] = tokens.slice(2)
  if (target.startsWith('-')) return null
  return { target, flags }
}
