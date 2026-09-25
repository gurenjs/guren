import { describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  attachControllerRefs,
  blankCommentsAndStrings,
  classActionMembers,
  collisionsReachedByName,
  controllerMethodFor,
  mutatesRecords,
  parseControllerMethods,
  AUTHORIZE_CALL_PATTERN,
  AUTH_CALL_PATTERN,
  DELETE_CALL_PATTERN,
  FORCE_WRITE_PATTERN,
  INERTIA_CALL_PATTERN,
  type ControllerTarget,
} from '../src/controller-methods'
import { firstClassDeclaration } from '../src/model-parser'
import { parseSourceFile } from '../src/parse-cache'
import { CAN_DENY_FILE_READS, writeWorkspaceFiles } from './helpers'

function scrub(source: string): string {
  const ast = parseSourceFile(source, 'test.ts')
  if (!ast) throw new Error('fixture failed to parse')
  return blankCommentsAndStrings(source, ast)
}

/**
 * Covered directly because `guren audit` and `guren check` each exercise only
 * the slice they use, so a gap in the shared half surfaces as an unexplained
 * verdict in whichever command happens to hit it.
 */
describe('blankCommentsAndStrings', () => {
  it('preserves offsets so body slices still line up with the AST', () => {
    const source = 'const a = 1 // comment\nconst b = "text"\n'

    expect(scrub(source)).toHaveLength(source.length)
  })

  it('blanks a line comment, so a commented-out call is not live code', () => {
    expect(AUTHORIZE_CALL_PATTERN.test(scrub('// await this.authorize("x")'))).toBe(false)
  })

  it('blanks string contents, so a call named inside a message does not count', () => {
    expect(AUTHORIZE_CALL_PATTERN.test(scrub('throw new Error("call this.authorize(x) first")'))).toBe(false)
  })

  it('blanks template quasis but keeps their expressions, which are live code', () => {
    const scrubbed = scrub('const msg = `use this.authorize(x)` + `${await this.authorize("edit")}`')

    // The quasi text is gone; the interpolated call survives.
    expect(scrubbed.match(/this\s*\.\s*authorize/gu)).toHaveLength(1)
  })

  // TypeScript allows a local type declaration inside a function, and its
  // member signatures read exactly like the calls these patterns look for.
  it('blanks a local type declaration whose members mimic a call', () => {
    expect(AUTHORIZE_CALL_PATTERN.test(scrub('type Decoy = { authorize(): void }'))).toBe(false)
  })

  it('leaves a real call intact', () => {
    expect(AUTHORIZE_CALL_PATTERN.test(scrub('await this.authorize("update", post)'))).toBe(true)
  })

  it('keeps offsets stable across an astral character', () => {
    const source = 'const emoji = "🎉" // done\nconst x = 1\n'

    expect(scrub(source)).toHaveLength(source.length)
  })
})

describe('controller member patterns', () => {
  it('matches this.authorize() with a type argument', () => {
    expect(AUTHORIZE_CALL_PATTERN.test('await this.authorize<Post>("update", post)')).toBe(true)
  })

  // `can()` returns a boolean and enforces nothing, so it must not read as
  // an authorization check.
  it('does not match this.can()', () => {
    expect(AUTHORIZE_CALL_PATTERN.test('if (await this.can("update", post)) {}')).toBe(false)
  })

  it('requires the this. receiver, since the members are protected', () => {
    expect(AUTHORIZE_CALL_PATTERN.test('await policy.authorize("update")')).toBe(false)
    expect(INERTIA_CALL_PATTERN.test('await other.inertia("Page")')).toBe(false)
  })

  it('matches both authentication paths, bearer tokens included', () => {
    expect(AUTH_CALL_PATTERN.test('await this.auth.userOrFail<UserRecord>()')).toBe(true)
    expect(AUTH_CALL_PATTERN.test('const id = await this.apiTokenUserId()')).toBe(true)
    expect(AUTH_CALL_PATTERN.test('const token = await this.apiToken()')).toBe(true)
  })

  // Optional reads enforce nothing on their own.
  it('does not treat auth.check() or auth.user() as authentication', () => {
    expect(AUTH_CALL_PATTERN.test('if (await this.auth.check()) {}')).toBe(false)
    expect(AUTH_CALL_PATTERN.test('const user = await this.auth.user()')).toBe(false)
  })

  // A bare name matches a *declaration* too, reporting an action that defines
  // its own helper for calling one.
  it('does not read a function declaration as a force write', () => {
    expect(FORCE_WRITE_PATTERN.test('function forceUpdate() { return null }')).toBe(false)
    expect(FORCE_WRITE_PATTERN.test('const forceCreate = () => null')).toBe(false)
    expect(FORCE_WRITE_PATTERN.test('await Post.forceUpdate({ id }, data)')).toBe(true)
  })

  it('counts deletes, updates, and force writes as record mutations', () => {
    expect(mutatesRecords('await Post.delete({ id })')).toBe(true)
    expect(mutatesRecords('await Post.update({ id }, data)')).toBe(true)
    expect(mutatesRecords('await Post.where("id", id).update(data)')).toBe(true)
    expect(mutatesRecords('await Post.forceUpdate({ id }, data)')).toBe(true)
    expect(mutatesRecords('const post = await Post.find(1)')).toBe(false)
  })

  // `.update(` is a common method name; without the receiver discipline every
  // progress bar or state container in an action would read as a write.
  it('does not read an arbitrary update() as a record mutation', () => {
    expect(mutatesRecords('progress.update(50)')).toBe(false)
    expect(mutatesRecords('this.state.update(next)')).toBe(false)
  })

  it('matches a model deletion in both its static and chained forms', () => {
    expect(DELETE_CALL_PATTERN.test('await Post.delete({ id })')).toBe(true)
    expect(DELETE_CALL_PATTERN.test('await Post.forceDelete({ id })')).toBe(true)
    expect(DELETE_CALL_PATTERN.test('await Post.where("id", id).delete()')).toBe(true)
  })

  // Without the receiver constraints, every cache eviction in an action would
  // read as a record deletion.
  it('does not match a plain map or cache eviction', () => {
    expect(DELETE_CALL_PATTERN.test('cache.delete(key)')).toBe(false)
    expect(DELETE_CALL_PATTERN.test('this.seen.delete(id)')).toBe(false)
  })
})

describe('parseControllerMethods', () => {
  it('keys bodies by ClassName.method and reports the file they came from', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guren-controller-methods-'))
    try {
      await writeWorkspaceFiles(dir, {
        'app/Http/Controllers/PostController.ts': `
import { Controller } from '@guren/core'

export class PostController extends Controller {
  async index() {
    return this.inertia('posts/Index', {})
  }
}
`,
      })

      const { methods, collisions } = await parseControllerMethods(dir)

      expect(collisions).toEqual([])
      const info = methods.get('PostController.index')
      expect(info?.filePath).toBe('app/Http/Controllers/PostController.ts')
      expect(INERTIA_CALL_PATTERN.test(info!.body)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Both forms are legal to Router's types and its runtime dispatch, so a scan
  // that walks method declarations only leaves every class-field action with no
  // body — which reads as "could not verify".
  it('collects a class-field action as well as a method', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guren-controller-methods-field-'))
    try {
      await writeWorkspaceFiles(dir, {
        'app/Http/Controllers/PostController.ts': `
import { Controller } from '@guren/core'

export class PostController extends Controller {
  store = async () => {
    await this.authorize('create', Post)
    return this.json({})
  }

  show = () => this.inertia('posts/Show', {})

  async destroy() {
    return this.noContent()
  }
}
`,
      })

      const { methods } = await parseControllerMethods(dir)

      expect(AUTHORIZE_CALL_PATTERN.test(methods.get('PostController.store')!.body)).toBe(true)
      // An expression-bodied arrow has no block; the expression is the body.
      expect(INERTIA_CALL_PATTERN.test(methods.get('PostController.show')!.body)).toBe(true)
      expect(methods.has('PostController.destroy')).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // A file that will not open must not reject the whole promise and take the
  // check/audit run down with it.
  it.skipIf(!CAN_DENY_FILE_READS)('reports an unreadable controller instead of rejecting', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guren-controller-methods-unreadable-'))
    try {
      await writeWorkspaceFiles(dir, {
        'app/Http/Controllers/PostController.ts': `
import { Controller } from '@guren/core'

export class PostController extends Controller {
  async index() { return this.json({}) }
}
`,
      })
      // Discovery collects real files only, so the only way to reach the
      // failing read is to make a discovered file unopenable.
      const controller = join(dir, 'app/Http/Controllers/PostController.ts')
      await chmod(controller, 0o000)

      const { methods, unreadableFiles } = await parseControllerMethods(dir)

      expect(unreadableFiles).toEqual(['app/Http/Controllers/PostController.ts'])
      expect(methods.size).toBe(0)
      await chmod(controller, 0o644)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Routes carry a class name and not a file, so the scan cannot resolve
  // this — it reports it, and every caller has to say something about it.
  it('reports two same-named controller classes rather than silently picking one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guren-controller-methods-collision-'))
    try {
      const source = `
import { Controller } from '@guren/core'

export class PostController extends Controller {
  async index() { return this.json({}) }
}
`
      await writeWorkspaceFiles(dir, {
        'app/Http/Controllers/PostController.ts': source,
        'modules/blog/app/Http/Controllers/PostController.ts': source,
      })

      const { collisions } = await parseControllerMethods(dir)

      expect(collisions).toHaveLength(1)
      expect(collisions[0]?.className).toBe('PostController')
      expect(collisions[0]?.previousFile).not.toBe(collisions[0]?.currentFile)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/** The manifest half of the scan (RFC 0026 §5): the keys a `ControllerRef` resolved by identity is looked up by. */
describe('identity lookup', () => {
  const ref = (file: string, exportName: string, action = 'store') =>
    ({ name: 'PostController', action, file, exportName, resolved: 'identity' as const })

  async function scan(files: Record<string, string>) {
    const dir = await mkdtemp(join(tmpdir(), 'guren-controller-methods-identity-'))
    try {
      await writeWorkspaceFiles(dir, files)
      return await parseControllerMethods(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  const body = (marker: string) => `import { Controller } from '@guren/core'

class PostController extends Controller {
  async store() { return this.json('${marker}') }
}

export { PostController, PostController as Posts }
export default PostController
`

  it('keys every name a file exports the class under, and reads a same-named class from its own file', async () => {
    const result = await scan({
      'app/Http/Controllers/PostController.ts': body('root'),
      'modules/blog/app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'

export default class PostController extends Controller {
  async store() { return this.json('blog') }
}
`,
    })
    const root = 'app/Http/Controllers/PostController.ts'
    const blog = 'modules/blog/app/Http/Controllers/PostController.ts'

    for (const exportName of ['PostController', 'Posts', 'default']) {
      expect(controllerMethodFor(result, ref(root, exportName))).toMatchObject({ by: 'identity', info: { filePath: root } })
    }
    expect(controllerMethodFor(result, ref(blog, 'default'))).toMatchObject({ by: 'identity', info: { filePath: blog } })
    expect(controllerMethodFor(result, ref(blog, 'PostController')).by).toBe('name')
  })

  it('answers no body for an action the placed class does not declare, rather than another class\'s', async () => {
    const result = await scan({
      'app/Http/Controllers/PostController.ts': body('root'),
      'modules/blog/app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'

export class PostController extends Controller {
  async destroy() { return this.noContent() }
}
`,
    })
    expect(controllerMethodFor(result, ref('modules/blog/app/Http/Controllers/PostController.ts', 'PostController'))).toMatchObject({ by: 'identity', info: undefined })
  })

  it('answers no body for a placed class whose file did not parse, rather than a same-named class\'s', async () => {
    const result = await scan({
      'app/Http/Controllers/PostController.ts': body('root'),
      'modules/blog/app/Http/Controllers/PostController.ts': 'export default class PostController {',
    })
    expect(result.collisions).toEqual([])
    expect(controllerMethodFor(result, ref('modules/blog/app/Http/Controllers/PostController.ts', 'default'))).toMatchObject({ by: 'identity', info: undefined })
  })

  it('gives a name-only reference no body when every same-named declaration is a class the child imported', async () => {
    const result = await scan({ 'app/Http/Controllers/PostController.ts': body('root') })
    const nameOnly = { name: 'PostController', action: 'store', file: null, exportName: null, resolved: 'name-only' as const }

    expect(controllerMethodFor(result, { ...nameOnly, unimported: [] })).toMatchObject({ by: 'elsewhere', info: undefined })
    expect(controllerMethodFor(result, { ...nameOnly, unimported: ['app/Http/Controllers/PostController.ts'] }).by).toBe('name')
    // A definition the routes file registered carries no manifest evidence either way.
    expect(controllerMethodFor(result, { name: 'PostController', action: 'store' }).by).toBe('name')
  })

  it('reads an unexported same-named class by name, since the child can never match one', async () => {
    const result = await scan({
      'app/Http/Controllers/NoteController.ts': `import { Controller } from '@guren/core'

class NoteController extends Controller {
  async store() { return this.json('colocated') }
}
`,
    })
    const nameOnly = { name: 'NoteController', action: 'store', file: null, exportName: null, resolved: 'name-only' as const, unimported: [] }
    expect(controllerMethodFor(result, nameOnly)).toMatchObject({ by: 'name', info: { filePath: 'app/Http/Controllers/NoteController.ts' } })
  })

  it('reads a name-only reference the routes file or entry declares as elsewhere, even beside an unexported class', async () => {
    const result = await scan({
      'app/Http/Controllers/NoteController.ts': "import { Controller } from '@guren/core'\n\nclass NoteController extends Controller {\n  async store() { return this.json('x') }\n}\n",
    })
    const nameOnly = { name: 'NoteController', action: 'store', file: null, exportName: null, resolved: 'name-only' as const, unimported: [] }
    expect(controllerMethodFor(result, { ...nameOnly, inRouteSource: true })).toMatchObject({ by: 'elsewhere', info: undefined })
  })

  it('counts a type-only export as no export of the class', async () => {
    const result = await scan({
      'app/Http/Controllers/NoteController.ts': "import { Controller } from '@guren/core'\n\nclass NoteController extends Controller {\n  async store() { return this.json('x') }\n}\n\nexport type { NoteController }\nexport { type NoteController as Notes }\n",
    })
    expect(result.declarations[0]?.exportNames).toEqual([])
  })

  it('follows the name only to a declaration that could be the routed class, not to a last-scanned exported one', async () => {
    const result = await scan({
      'app/Http/Controllers/A.ts': body('failed-import'),
      'app/Http/Controllers/B.ts': body('imported'),
    })
    const nameOnly = { name: 'PostController', action: 'store', file: null, exportName: null, resolved: 'name-only' as const }
    for (const unimported of [['app/Http/Controllers/A.ts'], ['app/Http/Controllers/B.ts']]) {
      expect(controllerMethodFor(result, { ...nameOnly, unimported }).info?.filePath).toBe(unimported[0])
    }
  })

  it('reports a collision only for a class some route reached by its name alone', async () => {
    const result = await scan({
      'app/Http/Controllers/PostController.ts': body('root'),
      'modules/blog/app/Http/Controllers/PostController.ts': body('blog'),
    })
    const placed = [ref('app/Http/Controllers/PostController.ts', 'default')]
    expect(collisionsReachedByName(result, placed)).toEqual([])
    expect(collisionsReachedByName(result, [...placed, { name: 'PostController', action: 'store' }])).toHaveLength(1)
  })
})

describe('attachControllerRefs', () => {
  const placed = { name: 'PostController', action: 'store', file: 'app/Http/Controllers/PostController.ts', exportName: 'default', resolved: 'identity' as const }

  it('gives a registered definition the manifest\'s reference for the same route', () => {
    const [definition] = attachControllerRefs(
      [{ method: 'post', path: '/posts', controller: { name: 'PostController', action: 'store' } }],
      { routes: [{ method: 'POST', path: '/posts', controller: placed }], warnings: [] } as never,
    )
    expect(definition?.controller).toEqual(placed)
  })

  it('keeps the name when the manifest counts the route more often than the routes file', () => {
    const [definition] = attachControllerRefs(
      [{ method: 'POST', path: '/posts', controller: { name: 'PostController', action: 'store' } }],
      { routes: [{ method: 'POST', path: '/posts', controller: placed }, { method: 'POST', path: '/posts', controller: { ...placed, file: 'modules/blog/x.ts' } }], warnings: [] } as never,
    )
    expect(definition?.controller).toEqual({ name: 'PostController', action: 'store' })
  })

  it('tells two routes of one method, path and action apart by their names', () => {
    const blog = { ...placed, file: 'modules/blog/app/Http/Controllers/PostController.ts' }
    const definitions = attachControllerRefs(
      [
        { method: 'POST', path: '/posts', name: 'posts.store', controller: { name: 'PostController', action: 'store' } },
        { method: 'POST', path: '/posts', name: 'blog.posts.store', controller: { name: 'PostController', action: 'store' } },
      ],
      {
        routes: [
          { method: 'POST', path: '/posts', name: 'blog.posts.store', controller: blog },
          { method: 'POST', path: '/posts', name: 'posts.store', controller: placed },
        ],
        warnings: [],
      } as never,
    )
    expect(definitions.map((definition) => definition.controller)).toEqual([placed, blog])
  })

  it('pairs a key both sides repeat equally nth to nth', () => {
    const second = { ...placed, file: 'app/Http/Controllers/Admin/PostController.ts' }
    const definitions = attachControllerRefs(
      [
        { method: 'POST', path: '/posts', controller: { name: 'PostController', action: 'store' } },
        { method: 'POST', path: '/posts', controller: { name: 'PostController', action: 'store' } },
      ],
      { routes: [{ method: 'POST', path: '/posts', controller: placed }, { method: 'POST', path: '/posts', controller: second }], warnings: [] } as never,
    )
    expect(definitions.map((definition) => definition.controller)).toEqual([placed, second])
  })

  it('pairs a key two modules share within its module, whatever order each side lists modules in', () => {
    const blog = { ...placed, file: 'modules/blog/app/Http/Controllers/PostController.ts' }
    const billing = { ...placed, file: 'modules/billing/app/Http/Controllers/PostController.ts' }
    const definitions = attachControllerRefs(
      [
        { method: 'POST', path: '/posts', module: 'billing', controller: { name: 'PostController', action: 'store' } },
        { method: 'POST', path: '/posts', module: 'blog', controller: { name: 'PostController', action: 'store' } },
      ],
      {
        routes: [
          { method: 'POST', path: '/posts', module: 'blog', controller: blog },
          { method: 'POST', path: '/posts', module: 'billing', controller: billing },
        ],
        warnings: [],
      } as never,
    )
    expect(definitions.map((definition) => definition.controller)).toEqual([billing, blog])
  })

  it('attaches nothing when the routes file counts the route more often than the manifest', () => {
    const definitions = attachControllerRefs(
      [
        { method: 'POST', path: '/posts', controller: { name: 'PostController', action: 'store' } },
        { method: 'POST', path: '/posts', controller: { name: 'PostController', action: 'store' } },
      ],
      { routes: [{ method: 'POST', path: '/posts', controller: placed }], warnings: [] } as never,
    )
    expect(definitions.map((definition) => definition.controller)).toEqual([
      { name: 'PostController', action: 'store' },
      { name: 'PostController', action: 'store' },
    ])
  })

  it('carries the files a name-only reference may still be declared in', () => {
    const nameOnly = { name: 'PostController', action: 'store', resolved: 'name-only' as const }
    const [definition] = attachControllerRefs(
      [{ method: 'POST', path: '/posts', controller: { name: 'PostController', action: 'store' } }],
      {
        routes: [{ method: 'POST', path: '/posts', controller: nameOnly }],
        warnings: [{ code: 'controller-import', message: 'app/Http/Controllers/PostController.ts could not be imported: boom' }],
      } as never,
      new Set(['PostController']),
    )
    expect(definition?.controller as ControllerTarget | undefined).toEqual({ ...nameOnly, unimported: ['app/Http/Controllers/PostController.ts'], inRouteSource: true })
  })
})

/**
 * The one answer to "which members of a controller class are actions", shared
 * by five scanners. Covered here rather than only through its callers, since a
 * gap in it surfaces once per command as an unexplained verdict.
 */
describe('classActionMembers', () => {
  function membersOf(source: string): { name: string; bodyType: string }[] {
    const ast = parseSourceFile(source, 'PostController.ts')
    if (!ast) throw new Error('fixture failed to parse')
    const classDecl = firstClassDeclaration(ast.program.body)
    if (!classDecl) throw new Error('fixture declares no class')
    return [...classActionMembers(classDecl)].map(({ name, body }) => ({
      name,
      bodyType: body.type,
    }))
  }

  it('yields both a method and a function-valued class field', () => {
    expect(
      membersOf(`class PostController {
  async index() {}
  store = async () => {}
  update = function () {}
}`),
    ).toEqual([
      { name: 'index', bodyType: 'BlockStatement' },
      { name: 'store', bodyType: 'BlockStatement' },
      { name: 'update', bodyType: 'BlockStatement' },
    ])
  })

  // An expression-bodied arrow has no block, so the expression is the body —
  // which is why an emptiness rule must test for the block before its length.
  it('yields the expression itself as the body of a concise arrow', () => {
    expect(membersOf('class PostController {\n  show = () => this.inertia("posts/Show", {})\n}')).toEqual([
      { name: 'show', bodyType: 'CallExpression' },
    ])
  })

  // Structural question only: hoisting any of these filters in here would
  // apply them to callers that never asked for them.
  it('yields constructor, static and private members, leaving those filters to callers', () => {
    expect(
      membersOf(`class PostController {
  constructor() {}
  static make() {}
  private helper() {}
  protected guard = () => true
}`).map((m) => m.name),
    ).toEqual(['constructor', 'make', 'helper', 'guard'])
  })

  // Names come from the shared `memberKeyName` rule: a local identifier-only
  // test reads a computed key's literal text as the action name and drops a
  // quoted one that dispatches perfectly well.
  it('reads a quoted key and refuses to guess at a computed one', () => {
    expect(
      membersOf(`const store = 'destroy'
class PostController {
  [store]() {}
  'quoted'() {}
  'quotedField' = () => null
  plain() {}
}`).map((m) => m.name),
    ).toEqual(['quoted', 'quotedField', 'plain'])
  })

  // Neither carries a body a scanner could read, and a `#private` member is
  // unreachable by a route in the first place.
  it('skips fields that hold no function, overload signatures, and #private names', () => {
    expect(
      membersOf(`class PostController {
  perPage = 25
  title: string
  declare readonly kind: string
  overloaded(a: string): void
  overloaded(a: string): void {}
  #secret() {}
  accessor draft = () => null
}`).map((m) => m.name),
    ).toEqual(['overloaded'])
  })
})
