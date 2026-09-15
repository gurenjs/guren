// oxlint plugin: a `process.env.X` read in application code, where `X` belongs in
// the validated schema a config definition receives (RFC 0027 §7). Only files under
// `app/`, `config/`, `routes/` and `src/` relative to the lint's cwd: `bin/serve.ts`
// and `drizzle.config.ts` run outside an application. `NODE_ENV` and `GUREN_*` stay
// raw reads; `isRawEnvKey` copies @guren/server's, which a plugin cannot import, and
// `tests/oxlint-unvalidated-env-read.test.ts` pins the two together.
import { relative, sep } from 'node:path'
import { envKey } from './ast.js'

const APP_DIRECTORIES = new Set(['app', 'config', 'routes', 'src'])

function isRawEnvKey(key) {
  return key === 'NODE_ENV' || key.startsWith('GUREN_')
}

function inAppDirectory(context) {
  const path = relative(process.cwd(), context.physicalFilename ?? context.filename)
  return APP_DIRECTORIES.has(path.split(sep)[0])
}

const rule = {
  create(context) {
    if (!inAppDirectory(context)) return {}
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
