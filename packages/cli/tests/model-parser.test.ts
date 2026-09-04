import { describe, expect, it } from 'bun:test'
import {
  classUsesAuthenticatableBase,
  firstClassDeclaration,
  hasModelConfig,
  parseModelSource,
  resolveModelStringArrayConfig,
  staticStringProperty,
} from '../src/model-parser'
import { parseSourceFile } from '../src/parse-cache'

describe('parseModelSource', () => {
  it('parses defineModel pattern with belongsTo', () => {
    const source = `
import { defineModel, type BelongsToRecord } from '@guren/orm'
import { posts } from '../../db/schema.js'
import type { UserRecord } from './User.js'

export type PostRecord = typeof posts.$inferSelect

export class Post extends defineModel(posts) {
  static override relationTypes: { author: BelongsToRecord<UserRecord> } = {
    author: null,
  }
}

if (typeof Post.belongsTo === 'function') {
  Post.belongsTo('author', (() => import('./User.js').then((module) => module.User)) as any, 'authorId', 'id')
}
`
    const result = parseModelSource(source, '/app/Models/Post.ts')

    expect(result).not.toBeNull()
    expect(result!.className).toBe('Post')
    expect(result!.tableName).toBe('posts')
    expect(result!.usesAuth).toBe(false)
    expect(result!.hasSoftDeletes).toBe(false)
    expect(result!.relationships).toHaveLength(1)
    expect(result!.relationships[0].name).toBe('author')
    expect(result!.relationships[0].type).toBe('belongsTo')
  })

  it('parses AuthenticatableModel pattern with hasMany', () => {
    const source = `
import { AuthenticatableModel, type HasManyRecord } from '@guren/core'
import { users } from '../../db/schema.js'
import type { PostRecord } from './Post.js'

export class User extends AuthenticatableModel<UserRecord> {
  static override table = users
  static override relationTypes: { posts: HasManyRecord<PostRecord> } = {
    posts: [],
  }
}

if (typeof User.hasMany === 'function') {
  User.hasMany('posts', (() => import('./Post.js').then((module) => module.Post)) as any, 'authorId', 'id')
}
`
    const result = parseModelSource(source, '/app/Models/User.ts')

    expect(result).not.toBeNull()
    expect(result!.className).toBe('User')
    expect(result!.tableName).toBe('users')
    expect(result!.usesAuth).toBe(true)
    expect(result!.relationships).toHaveLength(1)
    expect(result!.relationships[0].name).toBe('posts')
    expect(result!.relationships[0].type).toBe('hasMany')
  })

  it('parses AuthenticatableModel passed as a defineModel base', () => {
    const source = `
import { AuthenticatableModel, defineModel, type HasManyRecord } from '@guren/core'
import { users } from '../../db/schema.js'
import type { PostRecord } from './Post.js'

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
}) {
  static override relationTypes: { posts: HasManyRecord<PostRecord> } = {
    posts: [],
  }
}

if (typeof User.hasMany === 'function') {
  User.hasMany('posts', (() => import('./Post.js').then((module) => module.Post)) as any, 'authorId', 'id')
}
`
    const result = parseModelSource(source, '/app/Models/User.ts')

    expect(result).not.toBeNull()
    expect(result!.className).toBe('User')
    expect(result!.tableName).toBe('users')
    expect(result!.usesAuth).toBe(true)
    expect(result!.relationships).toHaveLength(1)
    expect(result!.relationships[0].name).toBe('posts')
  })

  it('parses a defineModel options object written behind an as-const wrapper', () => {
    const source = `
import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '../../db/schema.js'

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  name: 'Account',
} as const) {}
`
    const result = parseModelSource(source, '/app/Models/User.ts')

    expect(result).not.toBeNull()
    expect(result!.usesAuth).toBe(true)
  })

  it('reads a string-array config written behind an as-const wrapper', () => {
    const source = `
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts) {
  static override fillable = ['title', 'body'] as const
}
`
    const ast = parseSourceFile(source, '/app/Models/Post.ts')
    const classDecl = firstClassDeclaration(ast!.program.body)!

    expect(resolveModelStringArrayConfig(classDecl, 'fillable')).toEqual(['title', 'body'])
  })

  it('reads a string-array defineModel option written behind an as-const wrapper', () => {
    // The composed path `guren audit` walks: findDefineModelOption reaches the
    // property, stringArrayEntries has to see through the array's own wrapper.
    const source = `
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts, { fillable: ['title'] as const }) {}
`
    const ast = parseSourceFile(source, '/app/Models/Post.ts')
    const classDecl = firstClassDeclaration(ast!.program.body)!

    expect(resolveModelStringArrayConfig(classDecl, 'fillable')).toEqual(['title'])
  })

  it('reads a defineModel base, a static string and array entries through wrappers', () => {
    const source = `
import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '../../db/schema.js'

export class User extends defineModel(users, {
  base: AuthenticatableModel satisfies typeof AuthenticatableModel,
}) {
  static override passwordHashField = 'secretHash' as const
  static override fillable = [('name' satisfies keyof UserRecord)]
}
`
    const ast = parseSourceFile(source, '/app/Models/User.ts')
    const classDecl = firstClassDeclaration(ast!.program.body)!

    expect(classUsesAuthenticatableBase(classDecl)).toBe(true)
    expect(staticStringProperty(classDecl, 'passwordHashField')).toBe('secretHash')
    expect(resolveModelStringArrayConfig(classDecl, 'fillable')).toEqual(['name'])
  })

  it('still treats a wrapped `undefined` option as the absent option it is', () => {
    // `defineModel` skips the assignment either way, so reading this as a
    // declared allowlist reports mass-assignment protection the runtime lacks.
    const source = `
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts, {
  fillable: undefined as string[] | undefined,
} as const) {}
`
    const ast = parseSourceFile(source, '/app/Models/Post.ts')
    const classDecl = firstClassDeclaration(ast!.program.body)!

    expect(hasModelConfig(classDecl, 'fillable')).toBe(false)
  })

  it('reads a relationship name written behind a wrapper', () => {
    const source = `
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts) {}

Post.belongsTo('author' as const, (() => null) as any, 'authorId', 'id')
`
    const result = parseModelSource(source, '/app/Models/Post.ts')

    expect(result!.relationships.map((r) => r.name)).toEqual(['author'])
  })

  it('does not flag a plain defineModel model as authenticatable', () => {
    const source = `
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts, { optionalOnCreate: ['slug'] }) {}
`
    const result = parseModelSource(source, '/app/Models/Post.ts')

    expect(result).not.toBeNull()
    expect(result!.tableName).toBe('posts')
    expect(result!.usesAuth).toBe(false)
  })

  it('detects SoftDeletes', () => {
    const source = `
import { defineModel, SoftDeletes } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends SoftDeletes(defineModel(posts)) {}
`
    const result = parseModelSource(source, '/app/Models/Post.ts')
    expect(result).not.toBeNull()
    expect(result!.hasSoftDeletes).toBe(true)
  })

  it('returns null for non-model files', () => {
    const source = `export const config = { key: 'value' }`
    const result = parseModelSource(source, '/app/config.ts')
    expect(result).toBeNull()
  })

  it('returns null for invalid syntax', () => {
    const source = `export class {{{ invalid`
    const result = parseModelSource(source, '/app/invalid.ts')
    expect(result).toBeNull()
  })

  it('merges body and call relationships', () => {
    const source = `
import { defineModel, type HasManyRecord, type BelongsToRecord } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts) {
  static override relationTypes: {
    author: BelongsToRecord<UserRecord>
    comments: HasManyRecord<CommentRecord>
  } = { author: null, comments: [] }
}

Post.belongsTo('author', () => import('./User.js'), 'authorId', 'id')
Post.hasMany('comments', () => import('./Comment.js'), 'postId', 'id')
`
    const result = parseModelSource(source, '/app/Models/Post.ts')

    expect(result).not.toBeNull()
    expect(result!.relationships).toHaveLength(2)
    expect(result!.relationships.find(r => r.name === 'author')?.type).toBe('belongsTo')
    expect(result!.relationships.find(r => r.name === 'comments')?.type).toBe('hasMany')
  })

  it('extracts attachment collections from the Attachable(...) declaration', () => {
    const source = `
import { Attachable, hasOneAttached, hasManyAttached } from '@guren/core'
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({
    image: 'require',
    variants: { thumb: { width: 320 }, og: { width: 1200, height: 630 } },
  }),
  images: hasManyAttached({ image: 'require' }),
  draftPdf: hasOneAttached(),
}) {}
`
    const result = parseModelSource(source, '/app/Models/Post.ts')

    expect(result).not.toBeNull()
    expect(result!.attachments).toEqual([
      { name: 'cover', kind: 'one', variants: ['thumb', 'og'] },
      { name: 'images', kind: 'many', variants: [] },
      { name: 'draftPdf', kind: 'one', variants: [] },
    ])
    expect(result!.tableName).toBe('posts')
  })

  it('reads the Attachable declaration through an outer mixin', () => {
    const source = `
import { Attachable, hasOneAttached, SoftDeletes } from '@guren/core'
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends SoftDeletes(Attachable(defineModel(posts), {
  cover: hasOneAttached(),
})) {}
`
    const result = parseModelSource(source, '/app/Models/Post.ts')

    expect(result!.attachments).toEqual([{ name: 'cover', kind: 'one', variants: [] }])
    expect(result!.hasSoftDeletes).toBe(true)
  })

  it('reports null attachments for models without the mixin', () => {
    const source = `
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts) {}
`
    const result = parseModelSource(source, '/app/Models/Post.ts')

    expect(result!.attachments).toBeNull()
  })

  it('keeps an empty Attachable declaration distinct from no mixin at all', () => {
    // Attachable(Base, {}) is a real Attachable model at runtime
    // (Post.attachments = {}), so it must not read as non-attachable.
    const source = `
import { Attachable } from '@guren/core'
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends Attachable(defineModel(posts), {}) {}
`
    const result = parseModelSource(source, '/app/Models/Post.ts')

    expect(result!.attachments).toEqual([])
  })

  it('unwraps transparent TypeScript expressions around the declaration', () => {
    const source = `
import { Attachable, hasOneAttached, type AttachmentsDeclaration } from '@guren/core'
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({ variants: { thumb: { width: 320 } } as const }),
} satisfies AttachmentsDeclaration) {}
`
    const result = parseModelSource(source, '/app/Models/Post.ts')

    expect(result!.attachments).toEqual([{ name: 'cover', kind: 'one', variants: ['thumb'] }])
  })

  it('marks a declaration with a spread as unreadable instead of reading it partially', () => {
    const source = `
import { Attachable, hasOneAttached } from '@guren/core'
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'
import { sharedCollections } from './shared.js'

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached(),
  ...sharedCollections,
}) {}
`
    const result = parseModelSource(source, '/app/Models/Post.ts')

    expect(result!.attachments).toBe('unreadable')
  })

  it('marks a collection whose options are built elsewhere as unreadable', () => {
    // The options object may carry variants the parser cannot see, so the
    // whole model is skipped rather than emitted with variants: never.
    const source = `
import { Attachable, hasOneAttached } from '@guren/core'
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'
import { coverOptions } from './options.js'

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached(coverOptions),
}) {}
`
    const result = parseModelSource(source, '/app/Models/Post.ts')

    expect(result!.attachments).toBe('unreadable')
  })

  it('marks a declaration that is not an object literal as unreadable', () => {
    const source = `
import { Attachable } from '@guren/core'
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'
import { declaration } from './declaration.js'

export class Post extends Attachable(defineModel(posts), declaration) {}
`
    const result = parseModelSource(source, '/app/Models/Post.ts')

    expect(result!.attachments).toBe('unreadable')
  })
})
