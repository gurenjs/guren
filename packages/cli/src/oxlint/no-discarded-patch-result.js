// oxlint plugin: a `PatchResult` nobody reads. The CLI's patch helpers report
// "could not apply" as a value (`{ modified: false, reason }`), never by throwing,
// so a call whose result is discarded is a scaffolder that goes on to print success
// over a file it did not change: `make:command` did that with `addImport`, leaving
// a registration naming an identifier the file never imports. Reports such a call as
// a bare statement, awaited or not, or under `void`, when the callee is bound by an
// import from the module in PATCH_RESULT_FUNCTIONS (named, aliased or namespace).
// Tests: `tests/oxlint-no-discarded-patch-result.test.ts` holds the table to the sources.
import { AWAIT, unwrap } from './ast.js'

/** Per module basename, the exports whose return type is `Promise<PatchResult>`. */
export const PATCH_RESULT_FUNCTIONS = {
  'patch-helpers': ['addImport', 'addToArrayOption', 'addToArrayArgument', 'addCreateAppOption'],
  'route-registrar': ['addRouteRegistrarCall'],
}

/** The table's key for an import source, or `undefined` for any other module. */
function moduleKey(source) {
  const match = /(?:^|\/)([^/]+?)(?:\.[cm]?[jt]s)?$/u.exec(source)
  const key = match?.[1]
  return key !== undefined && Object.hasOwn(PATCH_RESULT_FUNCTIONS, key) ? key : undefined
}

function importedName(specifier) {
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
}

const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'require the PatchResult a patch helper returns to be read rather than discarded' },
  },
  create(context) {
    // Local binding -> the helper it names; namespace binding -> the module key.
    const locals = new Map()
    const namespaces = new Map()

    /** The helper name a call discards, or `undefined`. */
    const discardedHelper = (expression) => {
      const call = unwrap(expression, AWAIT)
      if (call?.type !== 'CallExpression') return undefined
      const callee = unwrap(call.callee)
      if (callee?.type === 'Identifier') return locals.get(callee.name)
      if (callee?.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return undefined
      const object = unwrap(callee.object)
      if (object?.type !== 'Identifier') return undefined
      const key = namespaces.get(object.name)
      if (key === undefined) return undefined
      return PATCH_RESULT_FUNCTIONS[key].includes(callee.property.name) ? callee.property.name : undefined
    }

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return
        const key = moduleKey(node.source.value)
        if (key === undefined) return
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') {
            namespaces.set(specifier.local.name, key)
          } else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type') {
            const name = importedName(specifier)
            if (PATCH_RESULT_FUNCTIONS[key].includes(name)) locals.set(specifier.local.name, name)
          }
        }
      },
      ExpressionStatement(node) {
        let expression = unwrap(node.expression, AWAIT)
        if (expression?.type === 'UnaryExpression' && expression.operator === 'void') expression = expression.argument
        const helper = discardedHelper(expression)
        if (helper === undefined) return
        context.report({
          node,
          message:
            `\`${helper}()\` reports a patch it could not apply in its PatchResult, and this statement discards it. `
            + 'Read `.modified` / `.reason` (PATCH_REASONS) before reporting success.',
        })
      },
    }
  },
}

export const rules = { 'no-discarded-patch-result': rule }

export default { meta: { name: 'guren-no-discarded-patch-result' }, rules }
