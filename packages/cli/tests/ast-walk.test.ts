import { parse } from '@babel/parser'
import type { Expression, File, Node } from '@babel/types'
import { describe, expect, it } from 'bun:test'
import { literalString, objectLiteral, unwrapTypeAssertion } from '../src/ast-walk'

/**
 * Returns the initializer of `source`'s first `const x = …`.
 *
 * Calls `@babel/parser` directly rather than `parseSourceFile`: `ParenthesizedExpression`
 * is unreachable under that parser's plugin set, so `createParenthesizedExpressions` is
 * opt-in here. No JSX plugin either — `<T>x` does not parse when JSX claims that syntax.
 */
function firstInitializer(source: string, options: { parenthesized?: boolean } = {}): Expression {
  const ast: File = parse(source, {
    sourceType: 'module',
    plugins: ['typescript'],
    createParenthesizedExpressions: options.parenthesized ?? false,
  })
  const [statement] = ast.program.body
  if (statement?.type !== 'VariableDeclaration') throw new Error('expected a variable declaration')
  const init = statement.declarations[0]?.init
  if (!init) throw new Error('expected an initializer')
  return init
}

describe('unwrapTypeAssertion', () => {
  it('sees through every transparent wrapper spelling', () => {
    const cases: Array<[string, string]> = [
      ['as const', 'const x = { a: 1 } as const'],
      ['as T', 'const x = { a: 1 } as Options'],
      ['satisfies T', 'const x = { a: 1 } satisfies Options'],
      ['non-null assertion', 'const x = { a: 1 }!'],
      ['angle-bracket assertion', 'const x = <Options>{ a: 1 }'],
    ]

    for (const [label, source] of cases) {
      const unwrapped = unwrapTypeAssertion(firstInitializer(source))
      expect(unwrapped.type, label).toBe('ObjectExpression')
    }
  })

  it('sees through a parenthesized expression when the parser produces one', () => {
    const wrapped = firstInitializer('const x = ({ a: 1 })', { parenthesized: true })

    // Guards the fixture: without it the assertion below passes on a parser that dropped
    // the node, leaving the branch covered but never entered.
    expect(wrapped.type).toBe('ParenthesizedExpression')
    expect(unwrapTypeAssertion(wrapped).type).toBe('ObjectExpression')
  })

  it('unwraps repeatedly, not once', () => {
    const wrapped = firstInitializer('const x = (({ a: 1 } as const) satisfies Options)!', {
      parenthesized: true,
    })

    expect(unwrapTypeAssertion(wrapped).type).toBe('ObjectExpression')
  })

  it('returns anything else untouched', () => {
    const call = firstInitializer('const x = makeOptions()')

    expect(unwrapTypeAssertion(call)).toBe(call)
  })
})

describe('objectLiteral', () => {
  it('answers the literal under a wrapper', () => {
    const literal = objectLiteral(firstInitializer('const x = { a: 1 } satisfies Options'))

    expect(literal?.type).toBe('ObjectExpression')
    expect(literal?.properties).toHaveLength(1)
  })

  it('answers null for a node that denotes no literal, wrapped or not', () => {
    expect(objectLiteral(firstInitializer('const x = SHARED_OPTIONS as Options'))).toBeNull()
    expect(objectLiteral(firstInitializer('const x = [1] as const'))).toBeNull()
  })

  it('answers null for an absent node', () => {
    expect(objectLiteral(null)).toBeNull()
    expect(objectLiteral(undefined)).toBeNull()
  })
})

describe('unwrapTypeAssertion on a malformed node', () => {
  it('answers the node rather than throwing when a wrapper carries no expression', () => {
    // `literalString` forwards `unknown` here unvalidated, so a wrapper-shaped object
    // Babel never built must not take a scan down with it.
    const malformed = { type: 'TSAsExpression' } as unknown as Node

    expect(unwrapTypeAssertion(malformed)).toBe(malformed)
    expect(literalString(malformed)).toBeNull()
  })
})

describe('literalString', () => {
  it('reads a string through a wrapper, in either spelling', () => {
    expect(literalString(firstInitializer("const x = 'redirect' as const"))).toBe('redirect')
    expect(literalString(firstInitializer('const x = `/posts` satisfies string'))).toBe('/posts')
  })

  it('still misses rather than invents', () => {
    expect(literalString(firstInitializer('const x = ROUTE as string'))).toBeNull()
    expect(literalString(firstInitializer('const x = `/posts/${id}` as const'))).toBeNull()
  })
})
