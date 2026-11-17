/**
 * A channel pattern compiles to a `RegExp` without flags: `{param}` and `*` become
 * `[^.]+`, `**` becomes `.+`, and the rest stays regex source, so a `.` is one code
 * unit other than a line terminator. The client picks the name, so a pattern with no
 * other regex syntax character outside its `{param}`s is decided by a walk over
 * reachable positions instead, in O(name length × pattern length), with the regex's
 * answer; any other pattern is left to the backtracking regex.
 */

const PARAM = /\{[^}]+\}/g
const VARIABLE = /\{[^}]+\}|\*\*|\*/g
// ECMAScript's SyntaxCharacter set less `.` and `*`; every other character matches itself.
const OTHER_SYNTAX = /[\\^$+?()[\]{}|]/

const DOT = 0x2e

function isSegmentUnit(code: number): boolean {
  return code !== DOT
}

function isLineUnit(code: number): boolean {
  return code !== 0x0a && code !== 0x0d && code !== 0x2028 && code !== 0x2029
}

// The caller keeps `position + literal.length` within the name.
function literalAt(name: string, position: number, literal: string): boolean {
  for (let offset = 0; offset < literal.length; offset++) {
    const code = literal.charCodeAt(offset)
    const unit = name.charCodeAt(position + offset)
    if (code === DOT ? !isLineUnit(unit) : code !== unit) return false
  }
  return true
}

function afterLiteral(reach: Uint8Array, name: string, literal: string): Uint8Array {
  if (literal === '') return reach
  const next = new Uint8Array(reach.length)
  for (let position = 0; position + literal.length < reach.length; position++) {
    if (reach[position] === 1 && literalAt(name, position, literal)) next[position + literal.length] = 1
  }
  return next
}

function afterRun(reach: Uint8Array, name: string, accepts: (code: number) => boolean): Uint8Array {
  const next = new Uint8Array(reach.length)
  for (let position = 1; position < reach.length; position++) {
    if ((reach[position - 1] === 1 || next[position - 1] === 1) && accepts(name.charCodeAt(position - 1))) {
      next[position] = 1
    }
  }
  return next
}

export function isWalkableChannelPattern(pattern: string): boolean {
  return !OTHER_SYNTAX.test(pattern.replace(PARAM, ''))
}

export function walkChannelPattern(pattern: string, name: string): boolean {
  const tokens = [...pattern.matchAll(VARIABLE)]
  const leading = pattern.slice(0, tokens[0]?.index ?? pattern.length)
  if (leading.length > name.length || !literalAt(name, 0, leading)) return false

  let reach: Uint8Array = new Uint8Array(name.length + 1)
  reach[leading.length] = 1
  for (const [index, token] of tokens.entries()) {
    const literal = pattern.slice(token.index + token[0].length, tokens[index + 1]?.index ?? pattern.length)
    reach = afterRun(reach, name, token[0] === '**' ? isLineUnit : isSegmentUnit)
    reach = afterLiteral(reach, name, literal)
    if (!reach.includes(1)) return false
  }
  return reach[name.length] === 1
}
