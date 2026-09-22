// oxlint plugin: a `PatchResult` nobody reads. The CLI's patch helpers report
// "could not apply" as a value (a `PatchResult` or an `EntryWiring`), never by throwing,
// so a call whose result is discarded is a scaffolder that goes on to print success
// over a file it did not change. Reports such a call as a bare statement, awaited or
// not, or under `void`, when the callee is bound by an import from a module in
// PATCH_RESULT_FUNCTIONS (named, aliased or namespace). A plugin cannot read TS types,
// so the table is spelled here; `tests/oxlint-no-discarded-patch-result.test.ts`
// holds it to the sources.
import { AWAIT, importedName, unwrap } from './ast.js'

/** Per module basename, the exports whose return type is `Promise<PatchResult>` or `Promise<EntryWiring>`. */
export const PATCH_RESULT_FUNCTIONS = {
  'patch-helpers': ['addImport', 'addToArrayOption', 'addToArrayArgument', 'addCreateAppOption', 'addEntryWithImport'],
  'provider-registrar': ['addArrayOptionRegistration'],
  'route-registrar': ['addRouteRegistrarCall'],
}

/** The table's key for an import source, or `undefined` for any other module. */
function moduleKey(source) {
  const key = source.split('/').pop().replace(/\.[cm]?[jt]s$/u, '')
  return Object.hasOwn(PATCH_RESULT_FUNCTIONS, key) ? key : undefined
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
        // Imports come first in source, so empty maps mean no helper is in scope.
        if (locals.size === 0 && namespaces.size === 0) return
        const expression = unwrap(node.expression)
        const helper = discardedHelper(
          expression?.type === 'UnaryExpression' && expression.operator === 'void' ? expression.argument : expression,
        )
        if (helper === undefined) return
        context.report({
          node,
          message:
            `\`${helper}()\` reports a patch it could not apply in its result, and this statement discards it. `
            + 'Read `.modified` / `.reason` (PATCH_REASONS), or `.registered` / `.entry.reason` of an EntryWiring, before reporting success.',
        })
      },
    }
  },
}

export const rules = { 'no-discarded-patch-result': rule }

export default { meta: { name: 'guren-no-discarded-patch-result' }, rules }
