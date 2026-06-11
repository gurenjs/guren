import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { generateGuidelines } from '../src/guidelines'
import { createTempWorkspace } from './helpers'

describe('generateGuidelines', () => {
  it('generates basic guidelines for empty project', async () => {
    const workspace = await createTempWorkspace('guren-cli-guidelines-empty-')

    try {
      const output = await generateGuidelines({ cwd: workspace.dir })

      expect(output).toContain('# Project Guidelines')
      expect(output).toContain('## Naming Conventions')
      expect(output).toContain('## Security Rules (checked by `bunx guren audit`)')
      expect(output).toContain('## When Creating New Features')
      expect(output).toContain('bunx guren make:policy')
      expect(output).toContain('Run `bunx guren audit`')
    } finally {
      await workspace.cleanup()
    }
  })

  it('lists policies when present', async () => {
    const workspace = await createTempWorkspace('guren-cli-guidelines-policy-')

    try {
      await mkdir(join(workspace.dir, 'app/Policies'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Policies/PostPolicy.ts'),
        `export class PostPolicy {}`,
        'utf8',
      )

      const output = await generateGuidelines({ cwd: workspace.dir })

      expect(output).toContain('PostPolicy')
      expect(output).toContain('this.authorize')
    } finally {
      await workspace.cleanup()
    }
  })

  it('detects auth when configured', async () => {
    const workspace = await createTempWorkspace('guren-cli-guidelines-auth-')

    try {
      await mkdir(join(workspace.dir, 'app/Http/Controllers/Auth'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Controllers/Auth/LoginController.ts'),
        'export default class LoginController {}',
        'utf8',
      )
      await writeFile(
        join(workspace.dir, 'app/Models/User.ts'),
        `import { AuthenticatableModel } from '@guren/core'
import { users } from '../../db/schema.js'
export class User extends AuthenticatableModel<any> {
  static override table = users
}`,
        'utf8',
      )

      const output = await generateGuidelines({ cwd: workspace.dir })

      expect(output).toContain('Auth is configured with User model')
      expect(output).toContain('Session-based authentication')
    } finally {
      await workspace.cleanup()
    }
  })

  it('lists validators when present', async () => {
    const workspace = await createTempWorkspace('guren-cli-guidelines-validators-')

    try {
      await mkdir(join(workspace.dir, 'app/Http/Validators'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'app/Http/Validators/PostValidator.ts'),
        `import { z } from 'zod'; export const PostSchema = z.object({})`,
        'utf8',
      )

      const output = await generateGuidelines({ cwd: workspace.dir })

      expect(output).toContain('PostValidator')
      expect(output).toContain('Zod schemas')
    } finally {
      await workspace.cleanup()
    }
  })

  it('lists events and jobs when present', async () => {
    const workspace = await createTempWorkspace('guren-cli-guidelines-events-')

    try {
      await mkdir(join(workspace.dir, 'app/Events'), { recursive: true })
      await mkdir(join(workspace.dir, 'app/Jobs'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Events/OrderPlaced.ts'), 'export class OrderPlaced {}', 'utf8')
      await writeFile(join(workspace.dir, 'app/Jobs/ProcessOrder.ts'), 'export class ProcessOrder {}', 'utf8')

      const output = await generateGuidelines({ cwd: workspace.dir })

      expect(output).toContain('OrderPlaced')
      expect(output).toContain('ProcessOrder')
    } finally {
      await workspace.cleanup()
    }
  })
})
