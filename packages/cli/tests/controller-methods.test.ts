import { describe, expect, it } from 'bun:test'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  blankCommentsAndStrings,
  mutatesRecords,
  parseControllerMethods,
  AUTHORIZE_CALL_PATTERN,
  AUTH_CALL_PATTERN,
  DELETE_CALL_PATTERN,
  FORCE_WRITE_PATTERN,
  INERTIA_CALL_PATTERN,
} from '../src/controller-methods'
import { parseSourceFile } from '../src/parse-cache'
import { writeWorkspaceFiles } from './helpers'

function scrub(source: string): string {
  const ast = parseSourceFile(source, 'test.ts')
  if (!ast) throw new Error('fixture failed to parse')
  return blankCommentsAndStrings(source, ast)
}

/**
 * The scan and the vocabulary both commands judge controller bodies with.
 * Covered directly here because `guren audit` and `guren check` each exercise
 * only the slice they use, and a gap in the shared half would surface as an
 * unexplained verdict in whichever command happened to hit it.
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

  // A bare name matched a *declaration* too, so an action defining its own
  // helper was reported for calling one.
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

  // Both forms are legal to Router's types and its runtime dispatch, so a
  // scanner collecting only ClassMethod leaves every class-field action with
  // no body — which reads as "could not verify", not as what it says.
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

  // A file that will not open used to reject the whole promise, taking the
  // entire check/audit run down instead of producing a finding.
  it('reports an unreadable controller instead of rejecting', async () => {
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
      // Discovery collects real files only (a directory or dangling symlink
      // in its place is filtered before any read), so the only way to reach
      // the failing read is to make a discovered file unopenable.
      const controller = join(dir, 'app/Http/Controllers/PostController.ts')
      await chmod(controller, 0o000)
      const stillReadable = await readFile(controller, 'utf8').then(() => true, () => false)
      if (stillReadable) return // running as root: the mode says nothing

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
