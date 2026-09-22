import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { scanColumnConsumers, type ColumnConsumerModel, type ColumnConsumerScan, type ColumnRead } from '../src/column-consumers'
import { ParseCache } from '../src/parse-cache'
import { writeWorkspaceFiles } from './helpers'

let ROOT: string
let counter = 0

const MODEL_FILES: Record<string, string> = {
  'app/Models/Post.ts': "import { defineModel } from '@guren/core'\nimport { posts } from '../../db/schema'\n\nexport type PostRecord = typeof posts.$inferSelect\nexport class Post extends defineModel(posts) {}\n",
  'app/Models/User.ts': "import { defineModel } from '@guren/core'\nimport { users } from '../../db/schema'\n\nexport type UserRecord = typeof users.$inferSelect\nexport class User extends defineModel(users) {}\n",
}

const MODELS: ColumnConsumerModel[] = [
  { className: 'Post', file: 'app/Models/Post.ts' },
  { className: 'User', file: 'app/Models/User.ts' },
]

interface Fixture {
  models?: ColumnConsumerModel[]
  controllers?: Record<string, string>
  resources?: Record<string, string>
  pages?: Record<string, string>
  extra?: Record<string, string>
}

async function scan(fixture: Fixture): Promise<ColumnConsumerScan> {
  counter += 1
  const dir = join(ROOT, `app-${counter}`)
  const prefixed = (prefix: string, files: Record<string, string> = {}): Record<string, string> =>
    Object.fromEntries(Object.entries(files).map(([name, source]) => [`${prefix}/${name}`, source]))
  await writeWorkspaceFiles(dir, {
    ...MODEL_FILES,
    ...prefixed('app/Http/Controllers', fixture.controllers),
    ...prefixed('app/Http/Resources', fixture.resources),
    ...prefixed('resources/js/pages', fixture.pages),
    ...fixture.extra,
  })
  return scanColumnConsumers(dir, {
    models: fixture.models ?? MODELS,
    controllers: Object.keys(fixture.controllers ?? {}).map((name) => `app/Http/Controllers/${name}`),
    resources: Object.keys(fixture.resources ?? {}).map((name) => `app/Http/Resources/${name}`),
    pages: Object.keys(fixture.pages ?? {}).map((name) => ({ id: name.replace(/\.tsx$/, ''), file: `resources/js/pages/${name}` })),
  }, new ParseCache())
}

function reads(result: ColumnConsumerScan, model = 'Post'): string[] {
  return result.reads.filter((read) => read.model.className === model).map((read) => `${read.where}:${read.property}`)
}

function controller(body: string, imports = "import { Post } from '../../Models/Post.js'"): Record<string, string> {
  return {
    'PostController.ts': `import { Controller } from '@guren/core'\n${imports}\n\nexport class PostController extends Controller {\n${body}\n}\n`,
  }
}

beforeAll(async () => {
  ROOT = await mkdtemp(join(tmpdir(), 'guren-plan-impact-scan-'))
})

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true })
})

describe('scanColumnConsumers in controllers', () => {
  test('should report a property read on a record a query chain on the model returned', async () => {
    const result = await scan({
      controllers: controller(`  async show() {
    const post = await Post.where('id', 1).firstOrFail()
    return this.json({ title: post.title })
  }`),
    })

    expect(reads(result)).toEqual(['PostController.show:id', 'PostController.show:title'])
    expect(result.reads[1]).toMatchObject({ kind: 'controller', file: 'app/Http/Controllers/PostController.ts', line: 7 })
  })

  test('should count neither a comment nor a string nor template text that spells the read', async () => {
    const result = await scan({
      controllers: controller(`  async show() {
    const post = await Post.findOrFail(1)
    // post.title is shown on the page
    const label = 'post.title'
    /* post.body */
    return this.text(\`post.excerpt \${label}\`)
  }`),
    })

    expect(reads(result)).toEqual([])
  })

  test('should follow an import alias of the model class', async () => {
    const result = await scan({
      controllers: controller(
        `  async show() {
    const article = await Article.findOrFail(1)
    return this.text(article.title)
  }`,
        "import { Post as Article } from '../../Models/Post.js'",
      ),
    })

    expect(reads(result)).toEqual(['PostController.show:title'])
  })

  test('should not take a same-named class from another module for the model', async () => {
    const result = await scan({
      controllers: controller(
        `  async show() {
    const post = await Post.findOrFail(1)
    return this.text(post.title)
  }`,
        "import { Post } from '../../Services/Post.js'",
      ),
      extra: { 'app/Services/Post.ts': 'export class Post {}\n' },
    })

    expect(reads(result)).toEqual([])
  })

  test('should not follow a local the file never tied to the model', async () => {
    const result = await scan({
      controllers: controller(`  async show() {
    const post = this.payload()
    return this.text(post.title)
  }
  payload() {
    return { title: 'x' }
  }`),
    })

    expect(reads(result)).toEqual([])
  })

  test('should read through destructuring, an element callback and a plain alias', async () => {
    const result = await scan({
      controllers: controller(`  async index() {
    const posts = await Post.all()
    const titles = posts.map((post) => post.title)
    const [first] = posts
    const same = first
    const { excerpt, body: text } = same
    return this.json({ titles, excerpt, text })
  }`),
    })

    expect(reads(result).sort()).toEqual(['PostController.index:body', 'PostController.index:excerpt', 'PostController.index:title'])
  })

  test('should stop at a callback parameter that shadows a record with something else', async () => {
    const result = await scan({
      controllers: controller(`  async index() {
    const post = await Post.findOrFail(1)
    const others = [{ title: 'x' }]
    return this.json(others.map((post) => post.title))
  }`),
    })

    expect(reads(result)).toEqual([])
  })

  test('should read a literal computed key and report a key it cannot name', async () => {
    const result = await scan({
      controllers: controller(`  async show() {
    const post = await Post.findOrFail(1)
    const key = 'title'
    const { ...rest } = post
    return this.json([post['body'], post[key], rest])
  }`),
    })

    expect(reads(result)).toEqual(['PostController.show:body'])
    expect(result.opaque.map((read) => read.line)).toEqual([8, 9])
  })

  test('should take this.model() and an annotated record parameter', async () => {
    const result = await scan({
      controllers: controller(
        `  async update() {
    const post = this.model(Post)
    return this.text(summary(post) + post.slug)
  }`,
        "import { Post, type PostRecord } from '../../Models/Post.js'\n\nfunction summary(record: PostRecord): string {\n  return record.excerpt\n}",
      ),
    })

    expect(reads(result).sort()).toEqual([':excerpt', 'PostController.update:slug'])
  })

  test('should not take a map of records keyed by something else for a record', async () => {
    const result = await scan({
      controllers: controller(
        `  async show() {
    const byProvider: Record<string, Partial<UserRecord>> = { github: {} }
    return this.json(byProvider['github'])
  }`,
        "import type { UserRecord } from '../../Models/User.js'",
      ),
    })

    expect(result.reads).toEqual([])
    expect(result.opaque).toEqual([])
  })
})

describe('scanColumnConsumers on queries, lists and shadowing', () => {
  test('should read the column names a query on the model spells', async () => {
    const result = await scan({
      controllers: controller(`  async index() {
    const posts = await Post.where('published', true).orderBy('createdAt').select('title', 'body').get()
    const drafts = await Post.where({ status: 'draft' })
    return this.json({ posts, drafts })
  }`),
    })

    expect(reads(result)).toEqual([
      'PostController.index:published',
      'PostController.index:createdAt',
      'PostController.index:title',
      'PostController.index:body',
      'PostController.index:status',
    ])
  })

  test('should take a list for a list: its length and methods are no column, its elements are records', async () => {
    const result = await scan({
      controllers: controller(`  async index() {
    const posts = await Post.all()
    const page = await Post.paginate({ page: 1 })
    return this.json({ count: posts.length, first: posts[0].title, last: page.data.at(-1)?.body, total: page.total })
  }`),
    })

    expect(reads(result)).toEqual(['PostController.index:title', 'PostController.index:body'])
  })

  test('should report a spread of a record as a read of every column', async () => {
    const result = await scan({
      resources: {
        'PostResource.ts': "import { Resource } from '@guren/core'\nimport type { PostRecord } from '../../Models/Post.js'\n\nexport class PostResource extends Resource<PostRecord, {}> {\n  toArray() {\n    return { ...this.resource }\n  }\n}\n",
      },
      pages: {
        'posts/Card.tsx': "import type { PostRecord } from '@/app/Models/Post'\n\nexport default function Card({ post, posts }: { post: PostRecord; posts: PostRecord[] }) {\n  return <Row {...post} items={[...posts]} />\n}\n",
      },
    })

    expect(result.opaque.map((read) => `${read.where}:${read.line}`)).toEqual(['PostResource:6', 'posts/Card:4'])
  })

  test('should not take a parameter or a local named after the model class for the model', async () => {
    const result = await scan({
      controllers: controller(`  async show() {
    const find = async (Post: { find(id: number): Promise<{ title: string }> }) => (await Post.find(1)).title
    const other = (Post: unknown) => this.model(Post as never)
    return this.json({ find, other })
  }`),
    })

    expect(result.reads).toEqual([])
  })

  test("should attribute a module's model to its own file, not to the root's same-named class", async () => {
    const result = await scan({
      models: [...MODELS, { className: 'Post', file: 'modules/blog/app/Models/Post.ts' }],
      controllers: controller(`  async show() {
    const post = await Post.findOrFail(1)
    return this.text(post.title)
  }`, "import { Post } from '../../../modules/blog/app/Models/Post.js'"),
      extra: { 'modules/blog/app/Models/Post.ts': MODEL_FILES['app/Models/Post.ts']! },
    })

    expect(result.reads.map((read) => read.model.file)).toEqual(['modules/blog/app/Models/Post.ts'])
  })
})

describe('scanColumnConsumers in resources and pages', () => {
  const RESOURCE = `import { Resource } from '@guren/core'
import type { PostRecord } from '../../Models/Post.js'

export interface PostResourceData {
  title: string
}

export class PostResource extends Resource<PostRecord, PostResourceData> {
  toArray(): PostResourceData {
    const post = this.resource
    return { title: this.resource.title, body: post.body }
  }
}
`

  test('should read this.resource in a resource tied to the model by its import', async () => {
    const result = await scan({ resources: { 'PostResource.ts': RESOURCE } })

    expect(result.resources).toEqual([{ className: 'PostResource', file: 'app/Http/Resources/PostResource.ts', models: [MODELS[0]] }])
    expect(reads(result)).toEqual(['PostResource:title', 'PostResource:body'])
  })

  test('should not read this.resource in a resource that imports no model', async () => {
    const result = await scan({
      resources: { 'StatsResource.ts': "import { Resource } from '@guren/core'\n\nexport class StatsResource extends Resource<{ title: string }, {}> {\n  toArray() {\n    return { title: this.resource.title }\n  }\n}\n" },
    })

    expect(result.resources).toEqual([])
    expect(result.reads).toEqual([])
  })

  test("should read a page prop typed as a tied resource's data, through that resource", async () => {
    const result = await scan({
      resources: { 'PostResource.ts': RESOURCE },
      pages: {
        'posts/Show.tsx': `import type { PostResourceData } from '@/app/Http/Resources/PostResource'

interface Props {
  post: PostResourceData
  heading: string
}

export default function Show({ post, heading }: Props) {
  // {post.body}
  return <h1 title={heading.length > 0 ? 'post.excerpt' : ''}>{post.title}</h1>
}
`,
      },
    })

    const pageReads = result.reads.filter((read) => read.kind === 'page')
    expect(pageReads.map((read: ColumnRead) => [read.where, read.property, read.via])).toEqual([['posts/Show', 'title', 'PostResource']])
  })

  test('should read paginated data and a Data.<Model> prop', async () => {
    const result = await scan({
      resources: { 'PostResource.ts': RESOURCE },
      pages: {
        'posts/Index.tsx': `import type { PaginatedPageProps } from '@guren/core'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'

interface Props extends PaginatedPageProps<PostResourceData> {}

export default function Index({ data: posts }: Props) {
  return <ul>{posts.map((post) => <li key={post.id}>{post.title}</li>)}</ul>
}
`,
        'users/Show.tsx': `import type { Data } from '@/.guren/data.gen'

export default function Show(props: { user: Data.User }) {
  return <p>{props.user.email}</p>
}
`,
      },
    })

    expect(reads(result).filter((read) => read.startsWith('posts/'))).toEqual(['posts/Index:id', 'posts/Index:title'])
    expect(reads(result, 'User')).toEqual(['users/Show:email'])
  })

  test('should report a file that would not parse rather than read nothing from it', async () => {
    const result = await scan({ controllers: { 'Broken.ts': 'export class Broken {' } })

    expect(result.unreadable).toEqual(['app/Http/Controllers/Broken.ts'])
  })
})
