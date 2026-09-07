// oxlint plugin: `process.env.FOO ?? 'default'` falls back only on `undefined`, so a
// key present but blank (`FOO=` in .env, or a hosting dashboard's cleared variable)
// passes '' through and names something that does not exist. Six scaffolded configs
// shipped this: a session store called '', a cache store called '', an SMTP port of
// 0 from `Number('')`. `||` is what each fallback was written to mean.
// Reports only a non-empty string or numeric fallback — `?? ''` is identical under
// either operator, and a non-literal fallback cannot be judged from syntax.
// Tests: `tests/oxlint-nullish-env-default.test.ts`.
import { unwrap } from './ast.js'

/** `process.env.FOO` or `process.env['FOO']`, returning the variable name. */
function envKey(node) {
  const n = unwrap(node)
  if (n?.type !== 'MemberExpression') return undefined
  const env = unwrap(n.object)
  if (env?.type !== 'MemberExpression') return undefined
  const proc = unwrap(env.object)
  if (proc?.type !== 'Identifier' || proc.name !== 'process') return undefined
  const envProp = env.computed ? undefined : env.property?.name
  if (envProp !== 'env') return undefined
  if (n.computed) return n.property?.type === 'Literal' ? String(n.property.value) : undefined
  return n.property?.name
}

/** A literal `''` behaves the same under both operators, so it is not reported. */
function nonEmptyLiteralFallback(node) {
  const n = unwrap(node)
  if (n?.type !== 'Literal') return undefined
  if (typeof n.value === 'string') return n.value === '' ? undefined : JSON.stringify(n.value)
  if (typeof n.value === 'number') return String(n.value)
  return undefined
}

/**
 * Every env read the literal actually falls back for. `??` is left-associative,
 * so `A ?? B ?? 'lit'` is `(A ?? B) ?? 'lit'`: a blank A *and* B still yields ''.
 */
function envKeysReaching(node) {
  const n = unwrap(node)
  if (n?.type === 'LogicalExpression' && n.operator === '??') {
    return [...envKeysReaching(n.left), ...envKeysReaching(n.right)]
  }
  const key = envKey(n)
  return key === undefined ? [] : [key]
}

/** The reported expression as written, flattened so a wrapped chain stays one line. */
function text(context, node) {
  return `\`${context.sourceCode.getText(node).replace(/\s+/gu, ' ')}\``
}

const rule = {
  create(context) {
    return {
      LogicalExpression(node) {
        if (node.operator !== '??') return
        // Only the node holding the literal reports, so a chain reports once.
        const fallback = nonEmptyLiteralFallback(node.right)
        if (fallback === undefined) return
        const keys = envKeysReaching(node.left)
        if (keys.length === 0) return
        // Every key, not the last: `??` is left-associative, so a blank *first*
        // read wins and naming only the tail points at the wrong variable.
        const blank = keys.map((k) => `\`${k}=\``).join(' or ')
        context.report({
          message:
            `${text(context, node)} keeps a blank ${blank} as '', which is not ${fallback}. `
            + "Use `||`, or disable this line with the reason an empty value is meaningful here.",
          node,
        })
      },
    }
  },
}

export const rules = { 'no-nullish-env-default': rule }

export default { meta: { name: 'guren-nullish-env-default' }, rules }
