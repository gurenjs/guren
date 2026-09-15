// oxlint plugin: a `process.env.X` read where `X` belongs in the validated schema a
// config definition receives (RFC 0027 §7). Where it applies is the config's call:
// a scaffold enables it through `overrides` on application code, since `bin/serve.ts`
// and `drizzle.config.ts` run outside an application. `NODE_ENV` and `GUREN_*` stay
// raw reads; `isRawEnvKey` copies @guren/server's, which a plugin cannot import, and
// `tests/oxlint-unvalidated-env-read.test.ts` pins the two together.
import { envKey } from './ast.js'

function isRawEnvKey(key) {
  return key === 'NODE_ENV' || key.startsWith('GUREN_')
}

const rule = {
  create(context) {
    return {
      MemberExpression(node) {
        const key = envKey(node)
        if (key === undefined || isRawEnvKey(key)) return
        context.report({
          message:
            `\`process.env.${key}\` bypasses the validated environment. Declare ${key} in config/env.ts and read it `
            + 'from the `env` a config definition receives, or disable this line with the reason it stays a raw read.',
          node,
        })
      },
    }
  },
}

export const rules = { 'no-unvalidated-env-read': rule }

export default { meta: { name: 'guren-unvalidated-env-read' }, rules }
