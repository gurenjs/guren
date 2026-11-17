/**
 * A channel pattern compiles to a `RegExp` without flags: `{param}` and `*` become
 * `[^.]+`, `**` becomes `.+`, and the rest stays regex source, so a `.` is one code
 * unit other than a line terminator and `\.` is a dot. The client picks the name, so a
 * pattern with no other regex syntax is decided by a walk over reachable positions
 * instead, in O(name length × pattern length), with the regex's answer; any other
 * pattern is left to the backtracking regex.
 */

const VARIABLE = /\{[^}]+\}|\*\*|\*/y
// ECMAScript's SyntaxCharacter set less `.` and `*`; every other character matches itself.
const OTHER_SYNTAX = /[\\^$+?()[\]{}|]/
// Identity escapes of the regex: SyntaxCharacter and `/`, less `*`, `{` and `}`, which the
// replacements above rewrite even behind a `\`.
const LITERAL_ESCAPES = new Set('^$\\.+?()[]|/')

const DOT = 0x2e
/** A literal unit an unescaped `.` leaves: any code unit but a line terminator. */
const ANY = -1

type Run = (code: number) => boolean

interface ChannelPatternParts {
  leading: number[]
  steps: Array<{ run: Run; literal: number[] }>
}

function isSegmentUnit(code: number): boolean {
  return code !== DOT
}

function isLineUnit(code: number): boolean {
  return code !== 0x0a && code !== 0x0d && code !== 0x2028 && code !== 0x2029
}

/** `undefined` for a pattern holding regex syntax other than `.` and an identity escape. */
function parseChannelPattern(pattern: string): ChannelPatternParts | undefined {
  const parts: ChannelPatternParts = { leading: [], steps: [] }
  let literal = parts.leading
  let position = 0
  while (position < pattern.length) {
    VARIABLE.lastIndex = position
    const variable = VARIABLE.exec(pattern)
    if (variable) {
      literal = []
      parts.steps.push({ run: variable[0] === '**' ? isLineUnit : isSegmentUnit, literal })
      position = VARIABLE.lastIndex
      continue
    }
    const character = pattern[position]!
    if (character === '\\') {
      const escaped = pattern[position + 1]
      if (escaped === undefined || !LITERAL_ESCAPES.has(escaped)) return undefined
      literal.push(escaped.charCodeAt(0))
      position += 2
      continue
    }
    if (OTHER_SYNTAX.test(character)) return undefined
    literal.push(character === '.' ? ANY : character.charCodeAt(0))
    position += 1
  }
  return parts
}

// The caller keeps `position + literal.length` within the name.
function literalAt(name: string, position: number, literal: number[]): boolean {
  for (let offset = 0; offset < literal.length; offset++) {
    const code = literal[offset]!
    const unit = name.charCodeAt(position + offset)
    if (code === ANY ? !isLineUnit(unit) : code !== unit) return false
  }
  return true
}

function afterLiteral(reach: Uint8Array, name: string, literal: number[]): Uint8Array {
  if (literal.length === 0) return reach
  const next = new Uint8Array(reach.length)
  for (let position = 0; position + literal.length < reach.length; position++) {
    if (reach[position] === 1 && literalAt(name, position, literal)) next[position + literal.length] = 1
  }
  return next
}

function afterRun(reach: Uint8Array, name: string, accepts: Run): Uint8Array {
  const next = new Uint8Array(reach.length)
  for (let position = 1; position < reach.length; position++) {
    if ((reach[position - 1] === 1 || next[position - 1] === 1) && accepts(name.charCodeAt(position - 1))) {
      next[position] = 1
    }
  }
  return next
}

/** Whether `name` matches `pattern`, or `undefined` when the pattern is not walkable. */
export function walkChannelPattern(pattern: string, name: string): boolean | undefined {
  const parts = parseChannelPattern(pattern)
  if (parts === undefined) return undefined
  if (parts.leading.length > name.length || !literalAt(name, 0, parts.leading)) return false

  let reach: Uint8Array = new Uint8Array(name.length + 1)
  reach[parts.leading.length] = 1
  for (const step of parts.steps) {
    reach = afterRun(reach, name, step.run)
    reach = afterLiteral(reach, name, step.literal)
    if (!reach.includes(1)) return false
  }
  return reach[name.length] === 1
}
