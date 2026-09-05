// oxlint plugin: a bare `expect(...).resolves` / `expect(...).rejects` statement can
// never fail its test: the matcher's promise is discarded, so the callback ends first.
// Twenty-two shipped before one was noticed. Neither published rule catches it:
// `typescript/no-floating-promises` decides by type and bun-types declares the chain
// as returning `void`; `jest/valid-expect` only knows `expect` from jest or vitest.
// Syntactic and import-agnostic: reports the chain as a bare statement, under `void`,
// or as a `forEach` arrow body; recognises aliases (`expect as verify`) and
// `t.expect`; a file declaring its own `expect` is left alone. Tests: the .test.ts next door.

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
