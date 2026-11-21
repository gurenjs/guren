import { describe, expect, test } from 'bun:test'

import { appEntryAdditions } from '../src/change/app-entry'

const BASE = `import { createApp } from '@guren/core'
import { registerWebRoutes } from '../routes/web.js'

const app = createApp({
  routes: registerWebRoutes,
  providers: [AuthProvider],
})

export default app
`

const added = (head: string, base = BASE) => appEntryAdditions(base, head, 'src/app.ts')

/** `BASE` with `name` appended to its providers and imported from `app/Providers/<name>`, as `plan:scaffold` writes it. */
const withProvider = (name: string, base = BASE): string =>
  base.replace("import { registerWebRoutes }", `import ${name} from '../app/Providers/${name}.js'\nimport { registerWebRoutes }`).replace('[AuthProvider]', `[AuthProvider, ${name}]`)

describe('appEntryAdditions', () => {
  test('should name each entry added to the two lists with the import binding it', () => {
    const head = withProvider('CommentPolicyProvider').replace('routes: registerWebRoutes,', "routes: registerWebRoutes,\n  config: [queue],").replace("import { createApp }", "import queue from '../config/queue.js'\nimport { createApp }")
    expect(added(head)).toEqual([
      { list: 'providers', name: 'CommentPolicyProvider' },
      { list: 'config', name: 'queue' },
    ])
  })

  test('should read a list the head creates, an entry put ahead of the kept ones, and a name the base imports already', () => {
    const created = BASE.replace('  providers: [AuthProvider],\n', '')
    expect(added(created.replace('routes: registerWebRoutes,', 'routes: registerWebRoutes,\n  providers: [P],').replace("import { createApp }", "import P from './P.js'\nimport { createApp }"), created)).toEqual([{ list: 'providers', name: 'P' }])
    expect(added(withProvider('P').replace('[AuthProvider, P]', '[P, AuthProvider]'))).toEqual([{ list: 'providers', name: 'P' }])
    const imported = BASE.replace("import { createApp }", "import P from './P.js'\nimport { createApp }")
    expect(added(imported.replace('[AuthProvider]', '[AuthProvider, P]'), imported)).toEqual([{ list: 'providers', name: 'P' }])
  })

  test('should read an edit that changes no list as no addition', () => {
    expect(added(BASE.replace('const app', '// The application.\nconst app'))).toEqual([])
  })

  test('should refuse an edit beyond added entries and their imports', () => {
    const head = withProvider('P')
    const refused: Record<string, string> = {
      'an entry removed': BASE.replace('[AuthProvider]', '[]'),
      'a call as the entry': head.replace('[AuthProvider, P]', '[AuthProvider, P()]'),
      'a spread': head.replace('[AuthProvider, P]', '[AuthProvider, ...P]'),
      'a type import': head.replace('import P from', 'import type P from'),
      'an import binding two names': head.replace('import P from', 'import P, { other } from'),
      'no import': BASE.replace('[AuthProvider]', '[AuthProvider, P]'),
      'another option': head.replace('routes: registerWebRoutes', 'routes: otherRoutes'),
      'a statement': head.replace('export default app', "app.use('*', middleware)\n\nexport default app"),
      'a list that is no literal': head.replace('[AuthProvider, P]', 'list'),
    }
    for (const [label, text] of Object.entries(refused)) expect([label, added(text)]).toEqual([label, undefined])
    const two = BASE.replace('[AuthProvider]', '[AuthProvider, Other]')
    expect(added(two.replace('[AuthProvider, Other]', '[Other, AuthProvider]'), two)).toBeUndefined()
  })

  test('should refuse options a spread, a computed key or an accessor could carry a list through', () => {
    const head = (options: string): string => `import { createApp } from '@guren/core'\nimport P from './P.js'\nconst app = createApp({ ${options} })\n`
    const base = (options: string): string => `import { createApp } from '@guren/core'\nconst app = createApp({ ${options} })\n`
    expect(added(head('providers: [P], ...shared'), base('...shared'))).toBeUndefined()
    expect(added(head('...shared, providers: [P]'), base('...shared'))).toBeUndefined()
    expect(added(head("['providers']: [A], providers: [P]"), base("['providers']: [A]"))).toBeUndefined()
    expect(added(head('get providers() { return [A] }, providers: [P]'), base('get providers() { return [A] }'))).toBeUndefined()
    expect(added(head('__proto__: shared, providers: [P]'), base('__proto__: shared'))).toBeUndefined()
    expect(added(head("'__proto__': shared, providers: [P]"), base("'__proto__': shared"))).toBeUndefined()
    // A registrar written as a method is named, and carries no list.
    expect(added(head('routes(router) {}, providers: [P]'), base('routes(router) {}'))).toEqual([{ list: 'providers', name: 'P' }])
  })

  test('should refuse an added import of a name the base reads, and a name the base imports as a type', () => {
    const reads = BASE.replace('routes: registerWebRoutes,', "routes: registerWebRoutes,\n  host: process.env.HOST,")
    expect(added(withProvider('process', reads).replace("'../app/Providers/process.js'", "'../app/Providers/Env.js'"), reads)).toBeUndefined()
    const typed = BASE.replace("import { createApp }", "import type { P } from './P.js'\nimport { createApp }")
    expect(added(typed.replace('[AuthProvider]', '[AuthProvider, P]'), typed)).toBeUndefined()
  })

  test('should read only the framework factory, called where no binding can shadow it', () => {
    const local = (text: string): string => text.replace("import { createApp } from '@guren/core'", "import * as core from '@guren/core'\nfunction createApp(options: object) { return core.createApp(options) }")
    expect(added(local(withProvider('P')), local(BASE))).toBeUndefined()
    const other = (text: string): string => text.replace("'@guren/core'", "'./factory.js'")
    expect(added(other(withProvider('P')), other(BASE))).toBeUndefined()
    const aliased = (text: string): string => text.replace('import { createApp }', 'import { createApp as make, createApp as createApp2 }')
    expect(added(aliased(withProvider('P')), aliased(BASE))).toBeUndefined()
    const nested = (text: string): string => text.replace('const app = createApp({', 'const build = (createApp: (options: object) => unknown) => createApp({').replace('})\n\nexport default app', '})\n\nexport default build')
    expect(added(nested(withProvider('P')), nested(BASE))).toBeUndefined()
    const exported = (text: string): string => text.replace('const app = createApp({', 'export default createApp({').replace('\nexport default app\n', '')
    expect(added(exported(withProvider('P')), exported(BASE))).toEqual([{ list: 'providers', name: 'P' }])
  })

  test('should refuse a file with no createApp() literal, or with two', () => {
    expect(appEntryAdditions('export default 1\n', 'export default 2\n', 'src/app.ts')).toBeUndefined()
    const twice = (text: string): string => `${text}createApp({ providers: [] })\n`
    expect(added(twice(withProvider('P')), twice(BASE))).toBeUndefined()
  })
})
