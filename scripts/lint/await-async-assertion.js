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
// This rule is syntactic and import-agnostic: any statement whose expression
// is a call chain rooted at `expect(...)` and passing through `.resolves` or
// `.rejects` is reported. Anything that consumes the promise — `await`,
// `return`, an arrow body, an argument to `Promise.all` — is not an
// ExpressionStatement, so it is not reported.
//
// JavaScript rather than TypeScript: oxlint hands JS plugins to Node's module
// loader, which does not take a `.ts` file. The tests live next door in
// `await-async-assertion.test.ts`.

const ASYNC_MODIFIERS = new Set(['resolves', 'rejects'])

/**
 * Walk the callee chain of a call down to its root. True when the root is
 * the `expect` identifier (directly, or via `expect.soft`-style members) and
 * the chain passes through `.resolves` or `.rejects` on the way.
 */
function isAsyncAssertion(expression) {
  let node = expression
  let sawModifier = false
  for (;;) {
    switch (node.type) {
      case 'CallExpression':
        node = node.callee
        break
      case 'MemberExpression':
        if (!node.computed && node.property.type === 'Identifier' && ASYNC_MODIFIERS.has(node.property.name)) {
          sawModifier = true
        }
        node = node.object
        break
      case 'Identifier':
        return sawModifier && node.name === 'expect'
      default:
        return false
    }
  }
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description: 'require `expect(...).resolves` / `expect(...).rejects` assertions to be awaited or returned',
    },
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        if (node.expression.type !== 'CallExpression') return
        if (!isAsyncAssertion(node.expression)) return
        context.report({
          node,
          message:
            'Async assertion is not awaited: a bare `expect(...).resolves` / `.rejects` statement can never fail its test. Add `await` (or `return` it).',
        })
      },
    }
  },
}

export default {
  meta: { name: 'guren' },
  rules: { 'await-async-assertion': rule },
}
