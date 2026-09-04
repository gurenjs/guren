// oxlint plugin: a bare `expect(...).resolves` / `expect(...).rejects`
// statement is an assertion that can never fail its test. The matcher returns
// a promise; written without `await` (or `return`), the test callback finishes
// first, and a promise that resolves when it should reject, or rejects with
// the wrong message, is never observed. Twenty-two of these shipped before the
// first one was noticed.
//
// Why a rule of our own, when two published ones exist for exactly this:
//
// - `typescript/no-floating-promises` decides by return type, and bun-types
//   declares the `.resolves` / `.rejects` chains as returning `void`
//   (`rejects: Matchers<unknown>`, `toThrow(): void`). The promise the matcher
//   really returns is invisible to type-aware linting, so the rule stays quiet
//   on every `bun:test` file. (Files importing from `vitest` are typed
//   honestly and that rule does catch them.)
// - oxlint's `jest/valid-expect` is syntactic, but only recognises `expect`
//   imported from jest or vitest — `bun:test` is not on its list — and this
//   repo's tests overwhelmingly import from `bun:test`.
//
// This rule is syntactic and import-agnostic. It reports an async assertion —
// a call chain rooted at `expect` and passing through `.resolves` or
// `.rejects` — wherever its promise is discarded:
//
// - as a statement of its own (`expect(p).rejects.toThrow()`),
// - under `void`, which for an assertion is never what was meant,
// - as the expression body of an arrow handed to `forEach`, which throws the
//   return value away (`.map` inside `Promise.all` is fine and not reported).
//
// `expect` is recognised by name, through an import alias (`expect as verify`)
// and as a member (`t.expect(...)` for a namespace import); an `await` on the
// wrong node of the chain (`(await expect(p)).resolves.toBe(1)`) does not
// count as consuming the matcher's promise. A file that declares its own
// `expect` (a DSL that merely shares the name) is left alone.
//
// JavaScript rather than TypeScript: oxlint hands JS plugins to Node's module
// loader, which does not take a `.ts` file. The tests live next door in
// `await-async-assertion.test.ts`.

const ASYNC_MODIFIERS = new Set(['resolves', 'rejects'])

/** Strip the wrappers that do not change what the chain ultimately calls. */
function unwrap(node) {
  for (;;) {
    switch (node.type) {
      case 'AwaitExpression':
        node = node.argument
        break
      case 'ChainExpression':
      case 'TSNonNullExpression':
      case 'TSAsExpression':
      case 'ParenthesizedExpression':
        node = node.expression
        break
      default:
        return node
    }
  }
}

/**
 * Walk the callee chain of a call down to its root. True when the root is
 * `expect` (by name or by member) and the chain passes through `.resolves`
 * or `.rejects` on the way.
 */
function isAsyncAssertion(expression, expectNames) {
  let node = unwrap(expression)
  if (node.type !== 'CallExpression') return false
  let sawModifier = false
  for (;;) {
    switch (node.type) {
      case 'CallExpression':
        node = unwrap(node.callee)
        break
      case 'MemberExpression':
        if (!node.computed && node.property.type === 'Identifier') {
          if (ASYNC_MODIFIERS.has(node.property.name)) sawModifier = true
          if (node.property.name === 'expect') return sawModifier
        }
        node = unwrap(node.object)
        break
      case 'Identifier':
        return sawModifier && expectNames.has(node.name)
      default:
        return false
    }
  }
}

const MESSAGE =
  'Async assertion is not awaited: a bare `expect(...).resolves` / `.rejects` can never fail its test. Add `await` (or `return` it).'

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'require `expect(...).resolves` / `expect(...).rejects` assertions to be awaited or returned',
    },
  },
  create(context) {
    // `expect` plus whatever local names an import binds it to. Filled while
    // the top of the file is visited, which is before any test body.
    const expectNames = new Set(['expect'])
    let declaresOwnExpect = false

    const report = (node) => {
      if (declaresOwnExpect) return
      context.report({ node, message: MESSAGE })
    }

    return {
      ImportSpecifier(node) {
        const imported = node.imported.type === 'Identifier' ? node.imported.name : node.imported.value
        if (imported === 'expect') expectNames.add(node.local.name)
      },
      FunctionDeclaration(node) {
        if (node.id?.name === 'expect') declaresOwnExpect = true
      },
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && node.id.name === 'expect') declaresOwnExpect = true
      },
      ExpressionStatement(node) {
        const expression = node.expression
        if (expression.type === 'UnaryExpression' && expression.operator === 'void') {
          if (isAsyncAssertion(expression.argument, expectNames)) report(node)
          return
        }
        if (expression.type === 'AwaitExpression') return
        if (isAsyncAssertion(expression, expectNames)) report(node)
      },
      ArrowFunctionExpression(node) {
        if (node.expression !== true) return
        const parent = node.parent
        if (parent?.type !== 'CallExpression' || !parent.arguments.includes(node)) return
        const callee = parent.callee
        const isForEach =
          callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && callee.property.name === 'forEach'
        if (!isForEach) return
        if (isAsyncAssertion(node.body, expectNames)) report(node.body)
      },
    }
  },
}

export default {
  meta: { name: 'guren' },
  rules: { 'await-async-assertion': rule },
}
