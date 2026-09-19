import { describe, it, expect } from 'bun:test'
import { buildErGraph, renderErSpec, type ErEdge } from '../src/spec-er'
import type { DiscoveredModel, ModelInfo, ModelRelationship } from '../src/model-parser'
import type { SchemaColumn, SchemaTable } from '../src/schema-parser'

function column(name: string, overrides: Partial<SchemaColumn> = {}): SchemaColumn {
  return { name, type: 'text', notNull: false, primaryKey: false, ...overrides }
}

function table(identifier: string, columns: SchemaColumn[], overrides: Partial<SchemaTable> = {}): SchemaTable {
  return { identifier, columns, module: null, dialect: 'pg', ...overrides }
}

function model(
  className: string,
  tableName: string | undefined,
  relationships: ModelRelationship[],
  overrides: Partial<DiscoveredModel> = {},
): DiscoveredModel {
  const info: ModelInfo = {
    className,
    filePath: `/app/Models/${className}.ts`,
    tableName,
    relationships,
    usesAuth: false,
    hasSoftDeletes: false,
    attachments: null,
    fillable: null,
    hidden: null,
    visible: null,
    casts: null,
    docsTags: [],
  }
  return { info, relPath: `app/Models/${className}.ts`, module: null, ...overrides }
}

const ID = column('id', { type: 'serial', primaryKey: true })

function summarize(edges: ErEdge[]): string[] {
  return edges.map((e) => `${e.from}->${e.to} ${e.cardinality} ${e.label} ${e.source}`)
}

describe('buildErGraph', () => {
  it('should emit a foreign-key edge when no relationship covers the pair', () => {
    const graph = buildErGraph(
      [
        table('posts', [ID, column('authorId', { type: 'integer', references: { table: 'users', column: 'id' } })]),
        table('users', [ID]),
      ],
      [],
    )

    expect(summarize(graph.edges)).toEqual(['posts->users manyToOne authorId foreignKey'])
    expect(graph.edges[0].foreignKeyColumns).toEqual(['authorId'])
    expect(graph.edges[0].relationship).toBeUndefined()
  })

  it('should emit a relationship edge when no foreign key covers the pair', () => {
    const graph = buildErGraph(
      [table('posts', [ID]), table('users', [ID])],
      [
        model('User', 'users', [{ name: 'posts', type: 'hasMany', relatedModel: 'Post' }]),
        model('Post', 'posts', []),
      ],
    )

    expect(summarize(graph.edges)).toEqual(['users->posts oneToMany posts relationship'])
    expect(graph.edges[0].relationship?.type).toBe('hasMany')
    expect(graph.edges[0].foreignKeyColumns).toEqual([])
  })

  it('should fold a foreign key into the relationship that already covers the same pair', () => {
    const graph = buildErGraph(
      [
        table('posts', [ID, column('authorId', { type: 'integer', references: { table: 'users', column: 'id' } })]),
        table('users', [ID]),
      ],
      [
        model('Post', 'posts', [{ name: 'author', type: 'belongsTo', relatedModel: 'User' }]),
        model('User', 'users', []),
      ],
    )

    expect(summarize(graph.edges)).toEqual(['posts->users manyToOne author both'])
    expect(graph.edges[0].foreignKeyColumns).toEqual(['authorId'])
    expect(graph.edges[0].relationship?.name).toBe('author')
  })

  it('should list every foreign-key column backing one relationship pair', () => {
    const graph = buildErGraph(
      [
        table('messages', [
          ID,
          column('senderId', { references: { table: 'users', column: 'id' } }),
          column('recipientId', { references: { table: 'users', column: 'id' } }),
        ]),
        table('users', [ID]),
      ],
      [
        model('Message', 'messages', [{ name: 'sender', type: 'belongsTo', relatedModel: 'User' }]),
        model('User', 'users', []),
      ],
    )

    expect(summarize(graph.edges)).toEqual(['messages->users manyToOne sender both'])
    expect(graph.edges[0].foreignKeyColumns).toEqual(['senderId', 'recipientId'])
  })

  it('should drop a relationship whose target table cannot be resolved', () => {
    const graph = buildErGraph(
      [table('posts', [ID])],
      [
        model('Post', 'posts', [
          { name: 'author', type: 'belongsTo', relatedModel: 'Missing' },
          { name: 'editor', type: 'belongsTo' },
          { name: 'owner', type: 'morphTo', relatedModel: 'User' },
        ]),
        model('Untabled', undefined, [{ name: 'posts', type: 'hasMany', relatedModel: 'Post' }]),
      ],
    )

    expect(graph.edges).toEqual([])
  })

  it('should resolve a same-named target to the owning module before the app root', () => {
    const models = [
      model('Post', 'billing_posts', [{ name: 'author', type: 'belongsTo', relatedModel: 'User' }], {
        module: 'billing',
        relPath: 'modules/billing/app/Models/Post.ts',
      }),
      model('User', 'users', []),
      model('User', 'billing_users', [], { module: 'billing', relPath: 'modules/billing/app/Models/User.ts' }),
    ]

    expect(summarize(buildErGraph([], models).edges)).toEqual([
      'billing_posts->billing_users manyToOne author relationship',
    ])
  })

  it('should order tables by identifier and edges by from, to, then label', () => {
    const tables = [table('zeta', [ID]), table('alpha', [ID]), table('mid', [ID])]
    const models = [
      model('Zeta', 'zeta', [
        { name: 'second', type: 'hasMany', relatedModel: 'Mid' },
        { name: 'first', type: 'hasOne', relatedModel: 'Mid' },
        { name: 'alphas', type: 'hasMany', relatedModel: 'Alpha' },
      ]),
      model('Alpha', 'alpha', []),
      model('Mid', 'mid', []),
    ]

    const graph = buildErGraph(tables, models)

    expect(graph.tables.map((t) => t.identifier)).toEqual(['alpha', 'mid', 'zeta'])
    expect(summarize(graph.edges)).toEqual([
      'zeta->alpha oneToMany alphas relationship',
      'zeta->mid oneToOne first relationship',
      'zeta->mid oneToMany second relationship',
    ])
  })

  it('should not mutate the arrays it is given', () => {
    const tables = [table('zeta', [ID]), table('alpha', [ID])]
    const models = [model('Zeta', 'zeta', []), model('Alpha', 'alpha', [])]

    buildErGraph(tables, models)

    expect(tables.map((t) => t.identifier)).toEqual(['zeta', 'alpha'])
    expect(models.map((m) => m.info.className)).toEqual(['Zeta', 'Alpha'])
  })
})

describe('renderErSpec', () => {
  it('should render tables, marks, and edges in graph order', () => {
    const graph = buildErGraph(
      [
        table('posts', [ID, column('authorId', { type: 'integer', references: { table: 'users', column: 'id' } })], {
          tableName: 'blog_posts',
          module: 'blog',
        }),
        table('users', [ID, column('email', { notNull: true })]),
      ],
      [model('User', 'users', [{ name: 'posts', type: 'hasMany', relatedModel: 'Post' }]), model('Post', 'posts', [])],
    )

    const { fileName, content } = renderErSpec(graph)

    expect(fileName).toBe('er.md')
    expect(content).toContain('    integer authorId FK')
    expect(content).toContain('    serial id PK')
    expect(content).toContain('  posts }o--|| users : authorId')
    expect(content).toContain('  users ||--o{ posts : posts')
    expect(content).toContain('## posts (table: blog_posts, module: blog)')
    expect(content).toContain('| email | text | not null |')
    expect(content).toContain('| authorId | integer | references users.id |')
    expect(content.indexOf('  posts }o--||')).toBeLessThan(content.indexOf('  users ||--o{'))
  })

  it('should render the Mermaid token of every cardinality a relationship can produce', () => {
    const graph = buildErGraph(
      [table('owners', [ID]), table('targets', [ID])],
      [
        model('Owner', 'owners', [
          { name: 'single', type: 'hasOne', relatedModel: 'Target' },
          { name: 'paired', type: 'belongsToMany', relatedModel: 'Target' },
          { name: 'direct', type: 'belongsTo', relatedModel: 'Target' },
          { name: 'many', type: 'hasMany', relatedModel: 'Target' },
          { name: 'through', type: 'hasManyThrough', relatedModel: 'Target' },
          { name: 'morphed', type: 'morphMany', relatedModel: 'Target' },
        ]),
        model('Target', 'targets', []),
      ],
    )

    const { content } = renderErSpec(graph)

    expect(content).toContain('  owners ||--o| targets : single')
    expect(content).toContain('  owners }o--o{ targets : paired')
    expect(content).toContain('  owners }o--|| targets : direct')
    expect(content).toContain('  owners ||--o{ targets : many')
    expect(content).toContain('  owners ||--o{ targets : through')
    expect(content).toContain('  owners ||--o{ targets : morphed')
  })

  it('should render an unknown attribute type rather than an empty token', () => {
    const { content } = renderErSpec(buildErGraph([table('posts', [column('title', { type: undefined })])], []))

    expect(content).toContain('    unknown title')
    expect(content).toContain('| title |  |  |')
  })

  it('should report no tables without emitting a diagram', () => {
    const { content } = renderErSpec(
      buildErGraph([], [model('User', 'users', [{ name: 'posts', type: 'hasMany', relatedModel: 'User' }])]),
    )

    expect(content).toContain('No tables found.')
    expect(content).not.toContain('erDiagram')
  })
})
