import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIST_ENTRY = join(import.meta.dir, '../../dist/index.d.ts')
const DIST_MODULE = JSON.stringify(join(import.meta.dir, '../../dist/index.js'))
const TSC_BIN = join(import.meta.dir, '../../../../node_modules/typescript/bin/tsc')

function compile(source: string): { exitCode: number | null; output: string } {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(`Expected ${DIST_ENTRY}; run \`bun run build server\` before this test.`)
  }

  const dir = mkdtempSync(join(tmpdir(), 'guren-inertia-overload-'))
  try {
    writeFileSync(join(dir, 'Controller.ts'), source)
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        strict: true,
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        skipLibCheck: true,
        noEmit: true,
      },
      files: ['Controller.ts'],
    }))

    const result = Bun.spawnSync([process.execPath, TSC_BIN, '-p', join(dir, 'tsconfig.json'), '--pretty', 'false'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('Controller.inertia() type errors', () => {
  // TypeScript explains a call no overload matches with the *last* overload's
  // error. With the string-component overload last, a missing page prop read
  // "not assignable to parameter of type 'string'" and never named the prop.
  test('should name the missing prop when a page contract call omits one', () => {
    const { exitCode, output } = compile(`import { Controller } from ${DIST_MODULE}

declare const page: { id: 'about/Index'; __props?: { title: string; description: string } }

export class AboutController extends Controller {
  async index(): Promise<Response> {
    return this.inertia(page, { title: 'About' })
  }
}
`)

    expect(exitCode).not.toBe(0)
    expect(output).toContain("Property 'description' is missing")
    expect(output).not.toContain("parameter of type 'string'")
  })
})

describe('Controller.inertia() deferred and lazy props', () => {
  const preamble = `import { Controller, defer, type ControllerInertiaProps } from ${DIST_MODULE}

type Post = { id: number }
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
declare const page: { id: 'posts/Index'; __props?: { posts: Post[]; title: string; total?: number } }
declare function allPosts(): Promise<Post[]>
`

  test('should accept defer() and a lazy function where the page declares the resolved type', () => {
    const { exitCode, output } = compile(`${preamble}
export class PostController extends Controller {
  async index() {
    return this.inertia(page, { posts: defer(() => allPosts()), title: () => 'Posts', total: defer(() => 3, 'stats') })
  }

  async plain() {
    return this.inertia('posts/Index', { posts: defer(() => allPosts()), title: () => Promise.resolve('Posts') })
  }
}

export const contractPosts: Equal<ControllerInertiaProps<PostController, 'index'>['posts'], Post[]> = true
export const plainPosts: Equal<ControllerInertiaProps<PostController, 'plain'>['posts'], Post[]> = true
export const plainTitle: Equal<ControllerInertiaProps<PostController, 'plain'>['title'], string> = true
`)

    expect(output).toBe('')
    expect(exitCode).toBe(0)
  })

  test('should reject a deferred prop whose resolved type is not the page prop', () => {
    const { exitCode, output } = compile(`${preamble}
export class PostController extends Controller {
  async index() {
    return this.inertia(page, { posts: defer(() => 'nope'), title: 'Posts' })
  }
}
`)

    expect(exitCode).not.toBe(0)
    expect(output).toContain("Type 'string' is not assignable to type 'Post[]'")
  })
})
