// oxlint rules for the machine-checkable half of the comment rules in
// .claude/rules/coding-standards.md: block length, banners, step labels,
// change-history wording, and `@param` tags that restate the name. Whether a
// comment narrates the code stays a review judgment. Comments come from
// oxlint's own parse, so template-literal contents are never inspected.
// JavaScript, not TypeScript: oxlint hands JS plugins to Node's module loader.
// Exercised through the real binary in `tests/oxlint-comments.test.ts`, like the sibling rule.

export const LIMITS = { body: 5, moduleHeader: 8 }

// A comment carrying any of these is never a finding: tooling directives, tags the
// framework reads, and `@deprecated`, which contributing/deprecation-policy.md
// requires and which always names the change it announces.
const PROTECTED =
  /@ts-|eslint|oxlint-|prettier-ignore|c8 ignore|istanbul ignore|@vite-ignore|webpackChunkName|__PURE__|@docs\b|@deprecated\b|@jsxImportSource|@vitest-environment|<reference\s|guren-audit-ignore/

// A form of `be` directly before the phrase marks a purpose (`is used to sign in`), not a past.
const HISTORY =
  /\b((?<!\b(?:is|are|be|was|were|being|been) )used to|previously|formerly|originally|was changed|has been changed|before this (change|pr|commit)|no longer)\b/i
const BANNER = /^\s*[-=─═*#]{3,}\s*(\S.*)?$/
const STEP = /^\s*step\s*\d+\b/i
const PARAM_RESTATES = /@param\s+(?:\{[^}]*\}\s+)?(\w+)\s*(?:-\s*)?(?:the\s+|a\s+|an\s+)?(\w+)\s*$/gim

function stripLine(text) {
  return text.replace(/^\s*\/\/\s?/, '').replace(/^\s*\*\s?/, '').trimEnd()
}

/** Group comments into the blocks a reader sees: a JSDoc, or a run of adjacent `//` lines. */
export function collectBlocks(comments, sourceLines, firstStatementLine) {
  const blocks = []
  let run = null
  for (const c of comments) {
    const startLine = c.loc.start.line
    const prefix = (sourceLines[startLine - 1] ?? '').slice(0, c.loc.start.column)
    const trailing = prefix.trim().length > 0
    if (c.type === 'Line') {
      const text = stripLine(`//${c.value}`)
      if (!trailing && run && run.endLine === startLine - 1) {
        run.lines.push(text)
        run.endLine = startLine
        run.raw += `\n${c.value}`
        run.loc = { start: run.loc.start, end: c.loc.end }
        continue
      }
      run = { line: startLine, bodyLine: startLine, endLine: startLine, lines: [text], trailing, raw: c.value, loc: c.loc }
      blocks.push(run)
      continue
    }
    run = null
    const rawLines = c.value.split('\n')
    const first = rawLines[0].trim()
    const last = rawLines[rawLines.length - 1].trim()
    const multi = rawLines.length > 1
    const dropOpener = multi && (first === '*' || first === '')
    const body = rawLines.slice(dropOpener ? 1 : 0, multi && last === '' ? -1 : undefined)
    // Body lines are numbered from the line after a dropped `/**` opener.
    blocks.push({ line: startLine, bodyLine: startLine + (dropOpener ? 1 : 0), endLine: c.loc.end.line, lines: body.map(stripLine), trailing, raw: c.value, loc: c.loc })
  }
  const header = blocks.find((b) => !b.trailing)
  if (header && header.line < firstStatementLine) header.isModuleHeader = true
  return blocks
}

/** The comment blocks of the file being linted that no protected token exempts. */
function auditableBlocks(context, program) {
  const source = context.sourceCode
  const comments = source.getAllComments()
  const firstStatementLine = program.body[0]?.loc?.start.line ?? Number.POSITIVE_INFINITY
  return collectBlocks(comments, source.text.split('\n'), firstStatementLine).filter((b) => !PROTECTED.test(b.raw))
}

const at = (line) => ({ start: { line, column: 0 }, end: { line, column: 0 } })

function blockRule(check) {
  return {
    create(context) {
      return {
        Program(program) {
          for (const b of auditableBlocks(context, program)) check(b, (message, loc = b.loc) => context.report({ message, loc }))
        },
      }
    },
  }
}

/** A block longer than the body a reader takes in at once; a module header gets a little more. */
const length = blockRule((b, report) => {
  const limit = b.isModuleHeader ? LIMITS.moduleHeader : LIMITS.body
  if (!b.trailing && b.lines.length > limit) {
    report(`${b.lines.length}-line comment; keep to ${limit} (module header ${LIMITS.moduleHeader}): one fact per line, no restatement or history`)
  }
})

const banner = blockRule((b, report) => {
  if (b.lines.length === 1 && BANNER.test(b.lines[0])) report('section banner; delete it, the next declaration is the heading')
})

const stepLabel = blockRule((b, report) => {
  b.lines.forEach((l, i) => {
    if (STEP.test(l)) report(`"${l.trim()}" narrates the code; delete it or state the constraint`, at(b.bodyLine + i))
  })
})

const history = blockRule((b, report) => {
  const m = b.lines.join('\n').match(HISTORY)
  if (m) report(`"${m[0]}" describes a change, which belongs in the commit message; state the present rule instead`)
})

const paramRestates = blockRule((b, report) => {
  for (const m of b.lines.join('\n').matchAll(PARAM_RESTATES)) {
    if (m[1].toLowerCase() === m[2].toLowerCase()) report(`@param ${m[1]} only repeats its name; delete the tag or say what the value must satisfy`)
  }
})

export const rules = {
  'comment-length': length,
  'comment-banner': banner,
  'comment-step-label': stepLabel,
  'comment-history': history,
  'comment-param-restates': paramRestates,
}

export default { meta: { name: 'guren-comments' }, rules }
