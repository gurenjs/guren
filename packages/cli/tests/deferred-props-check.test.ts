import { describe, expect, it } from 'bun:test'
import { runCheck } from '../src/check'
import { gatingResults, type CheckResult } from '../src/check-result'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

const PAGE = 'resources/js/pages/posts/Index.tsx'
const CONTROLLER = 'app/Http/Controllers/PostController.ts'

function controller(props: string, options: { imports?: string; page?: string } = {}): string {
  const imports = options.imports ?? "import { Controller, defer } from '@guren/core'"
  const page = options.page ?? 'pages.posts.Index'
  return `${imports}
import { pages } from '@/.guren/pages.gen'

export class PostController extends Controller {
  async index() {
    return this.inertia(${page}, ${props})
  }
}
`
}

function page(props: string): string {
  return `${props}
export default function Index({ posts }: Props) { return <ul>{posts?.length}</ul> }
`
}

const DEFER_POSTS = "{ posts: defer(() => []), title: 'Posts' }"

/** The deferred-prop results of a full check run over a throwaway app. */
async function deferredResults(files: Record<string, string>): Promise<{ results: CheckResult[]; gating: CheckResult[] }> {
  const workspace = await createTempWorkspace('guren-deferred-props-check-')
  try {
    await writeWorkspaceFiles(workspace.dir, files)
    const report = await runCheck({ cwd: workspace.dir })
    return {
      results: report.checks.filter((result) => result.key.startsWith('deferred-prop')),
      gating: gatingResults(report).filter((result) => result.key.startsWith('deferred-prop')),
    }
  } finally {
    await workspace.cleanup()
  }
}

describe('guren check deferred props', () => {
  it('warns when the page declares a deferred prop as required, without failing the gate', async () => {
    const { results, gating } = await deferredResults({
      [CONTROLLER]: controller(DEFER_POSTS),
      [PAGE]: page('interface Props { posts: Post[]; title: string }'),
    })

    expect(results).toHaveLength(1)
    const [finding] = results
    expect(finding?.key).toBe('deferred-prop:PostController.index:posts/Index:posts')
    expect(finding?.status).toBe('warn')
    expect(finding?.advisory).toBe(true)
    expect(finding?.filePath).toBe(CONTROLLER)
    expect(finding?.message).toContain("passes defer() for 'posts'")
    expect(finding?.message).toContain('`posts: Post[]` as required')
    expect(finding?.suggestion).toContain('`posts?: Post[]`')
    expect(finding?.suggestion).toContain('<Deferred>')
    expect(gating).toHaveLength(0)
  })

  it('passes a prop declared with ? or | undefined', async () => {
    const optional = await deferredResults({
      [CONTROLLER]: controller(DEFER_POSTS),
      [PAGE]: page('type Props = { posts?: Post[]; title: string }'),
    })
    expect(optional.results.map((result) => result.status)).toEqual(['pass'])

    const union = await deferredResults({
      [CONTROLLER]: controller(DEFER_POSTS),
      [PAGE]: page('interface Props { posts: Post[] | undefined; title: string }'),
    })
    expect(union.results.map((result) => result.status)).toEqual(['pass'])
  })

  it('judges a member the interface declares beside an extends clause, and cannot judge one it does not', async () => {
    const local = await deferredResults({
      [CONTROLLER]: controller("{ posts: defer(() => []), stats: defer(() => ({})) }"),
      [PAGE]: page(`import type { PaginatedPageProps } from '@guren/core'
interface Props extends PaginatedPageProps<Post> { posts: Post[] }`),
    })
    const byKey = new Map(local.results.map((result) => [result.key, result]))

    expect(byKey.get('deferred-prop:PostController.index:posts/Index:posts')?.status).toBe('warn')
    const inherited = byKey.get('deferred-prop:PostController.index:posts/Index:stats')
    expect(inherited?.status).toBe('warn')
    expect(inherited?.message).toContain('cannot be read: `Props` extends another type')
    expect(local.gating).toHaveLength(0)
  })

  it('reports a Props type it cannot close as unverifiable', async () => {
    const { results } = await deferredResults({
      [CONTROLLER]: controller(DEFER_POSTS),
      [PAGE]: page(`import type { PageProps } from '@guren/inertia-client/contracts'
import { pages } from '@/.guren/pages.gen'
type Props = PageProps<typeof pages.posts.Index>`),
    })

    expect(results).toHaveLength(1)
    expect(results[0]?.status).toBe('warn')
    expect(results[0]?.message).toContain('cannot be read')
    expect(results[0]?.suggestion).toContain('`posts?: …`')
  })

  it('follows an aliased import and a namespace import of defer', async () => {
    const aliased = await deferredResults({
      [CONTROLLER]: controller("{ posts: lazy(() => []) }", { imports: "import { Controller, defer as lazy } from '@guren/core'" }),
      [PAGE]: page('interface Props { posts: Post[] }'),
    })
    expect(aliased.results.map((result) => result.status)).toEqual(['warn'])

    const namespaced = await deferredResults({
      [CONTROLLER]: controller("{ posts: guren.defer(() => []) }", { imports: "import * as guren from '@guren/server'\nimport { Controller } from '@guren/core'" }),
      [PAGE]: page('interface Props { posts: Post[] }'),
    })
    expect(namespaced.results.map((result) => result.status)).toEqual(['warn'])
  })

  it('sees a deferred prop wrapped in always(), which the runtime announces as deferred too', async () => {
    const { results } = await deferredResults({
      [CONTROLLER]: controller("{ posts: always(defer(() => [])) }", { imports: "import { Controller, always, defer } from '@guren/core'" }),
      [PAGE]: page('interface Props { posts: Post[] }'),
    })
    expect(results.map((result) => result.status)).toEqual(['warn'])
  })

  it('contributes nothing for a controller that does not import defer from the framework', async () => {
    const { results } = await deferredResults({
      [CONTROLLER]: controller("{ posts: defer(() => []) }", { imports: "import { Controller } from '@guren/core'\nimport { defer } from '../../helpers'" }),
      'app/helpers.ts': 'export const defer = <T>(value: () => T) => value()\n',
      [PAGE]: page('interface Props { posts: Post[] }'),
    })

    expect(results).toHaveLength(0)
  })

  it('reads a string-literal page reference and a bracket manifest segment', async () => {
    const literal = await deferredResults({
      [CONTROLLER]: controller(DEFER_POSTS, { page: "'posts/Index'" }),
      [PAGE]: page('interface Props { posts: Post[] }'),
    })
    expect(literal.results.map((result) => result.key)).toEqual(['deferred-prop:PostController.index:posts/Index:posts'])

    const bracket = await deferredResults({
      [CONTROLLER]: controller(DEFER_POSTS, { page: "pages['posts'].Index" }),
      [PAGE]: page('interface Props { posts: Post[] }'),
    })
    expect(bracket.results.map((result) => result.status)).toEqual(['warn'])
  })

  it('reports a spread and a non-literal props argument as unverifiable, never passed', async () => {
    const spread = await deferredResults({
      [CONTROLLER]: controller("{ ...shared, posts: defer(() => []) }"),
      [PAGE]: page('interface Props { posts?: Post[] }'),
    })
    const spreadFinding = spread.results.find((result) => result.key.startsWith('deferred-props:'))
    expect(spreadFinding?.status).toBe('warn')
    expect(spreadFinding?.advisory).toBe(true)
    expect(spreadFinding?.message).toContain('spreads into the props')
    // A computed key hides its name the same way.
    const computed = await deferredResults({
      [CONTROLLER]: controller("{ [key]: defer(() => []) }").replace('async index() {', "async index() {\n    const key = 'posts'"),
      [PAGE]: page('interface Props { posts: Post[] }'),
    })
    expect(computed.results.map((result) => [result.key, result.status])).toEqual([['deferred-props:PostController.index:7', 'warn']])

    // The literal key beside the spread is still judged.
    expect(spread.results.find((result) => result.key.endsWith(':posts'))?.status).toBe('pass')

    // Only an action that itself calls defer() is reported for a props argument the read cannot open.
    const variable = await deferredResults({
      [CONTROLLER]: `import { Controller, defer } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export class PostController extends Controller {
  async index() {
    const props = { posts: defer(() => []) }
    return this.inertia(pages.posts.Index, props)
  }
  async show() {
    return this.inertia(pages.posts.Index, this.showProps())
  }
  showProps() { return { posts: [] } }
}
`,
      [PAGE]: page('interface Props { posts: Post[] }'),
    })
    expect(variable.results).toHaveLength(1)
    expect(variable.results[0]?.key).toBe('deferred-props:PostController.index:7')
    expect(variable.results[0]?.status).toBe('warn')
    expect(variable.results[0]?.message).toContain('not an object literal')
    expect(variable.gating).toHaveLength(0)
  })

  it('reports one finding per page key, however many calls in the action defer it', async () => {
    const { results } = await deferredResults({
      [CONTROLLER]: `import { Controller, defer } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export class PostController extends Controller {
  async index(admin: boolean) {
    if (admin) return this.inertia(pages.posts.Index, { posts: defer(() => []) })
    return this.inertia(pages.posts.Index, { posts: defer(() => []) })
  }
}
`,
      [PAGE]: page('interface Props { posts: Post[] }'),
    })
    expect(results.map((result) => result.key)).toEqual(['deferred-prop:PostController.index:posts/Index:posts'])
  })

  it('says nothing about a page with no Props, a key the page does not declare, or a page that does not exist', async () => {
    const { results } = await deferredResults({
      [CONTROLLER]: `import { Controller, defer } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export class PostController extends Controller {
  async index() { return this.inertia(pages.posts.Index, { extra: defer(() => 1) }) }
  async untyped() { return this.inertia(pages.posts.Untyped, { posts: defer(() => []) }) }
  async missing() { return this.inertia(pages.posts.Missing, { posts: defer(() => []) }) }
}
`,
      [PAGE]: page('interface Props { posts: Post[] }'),
      'resources/js/pages/posts/Untyped.tsx': 'export default function Untyped(props) { return null }\n',
    })

    expect(results).toHaveLength(0)
  })
})
