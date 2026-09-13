import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIST_ENTRY = join(import.meta.dir, '../../dist/index.d.ts')
const TSC_BIN = join(import.meta.dir, '../../../../node_modules/typescript/bin/tsc')

describe('Controller.inertia() type errors', () => {
  // TypeScript explains a call no overload matches with the *last* overload's
  // error. With the string-component overload last, a missing page prop read
  // "not assignable to parameter of type 'string'" and never named the prop.
  test('should name the missing prop when a page contract call omits one', () => {
    if (!existsSync(DIST_ENTRY)) {
      throw new Error(`Expected ${DIST_ENTRY}; run \`bun run build server\` before this test.`)
    }

    const dir = mkdtempSync(join(tmpdir(), 'guren-inertia-overload-'))
    try {
      writeFileSync(join(dir, 'AboutController.ts'), `import { Controller } from ${JSON.stringify(join(import.meta.dir, '../../dist/index.js'))}

declare const page: { id: 'about/Index'; __props?: { title: string; description: string } }

export class AboutController extends Controller {
  async index(): Promise<Response> {
    return this.inertia(page, { title: 'About' })
  }
}
`)
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          skipLibCheck: true,
          noEmit: true,
        },
        files: ['AboutController.ts'],
      }))

      const result = Bun.spawnSync([process.execPath, TSC_BIN, '-p', join(dir, 'tsconfig.json'), '--pretty', 'false'], {
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const output = `${result.stdout}${result.stderr}`

      expect(result.exitCode).not.toBe(0)
      expect(output).toContain("Property 'description' is missing")
      expect(output).not.toContain("parameter of type 'string'")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
