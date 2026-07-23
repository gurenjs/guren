import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { getChangedFiles } from '../src/changed-files'
import { createTempWorkspace } from './helpers'

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' })
  const code = await proc.exited
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed with code ${code}`)
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '--initial-branch=main'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await git(dir, ['config', 'user.name', 'Test'])
}

describe('getChangedFiles', () => {
  it('returns null outside a git repository', async () => {
    const workspace = await createTempWorkspace('guren-cli-changed-none-')
    try {
      const result = await getChangedFiles(workspace.dir)
      expect(result).toBeNull()
    } finally {
      await workspace.cleanup()
    }
  })

  it('includes untracked files', async () => {
    const workspace = await createTempWorkspace('guren-cli-changed-untracked-')
    try {
      await initRepo(workspace.dir)
      await writeFile(join(workspace.dir, 'README.md'), 'init', 'utf8')
      await git(workspace.dir, ['add', '.'])
      await git(workspace.dir, ['commit', '-m', 'init'])

      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Models/Post.ts'), 'export class Post {}', 'utf8')

      const result = await getChangedFiles(workspace.dir)
      expect(result).not.toBeNull()
      expect(result!.has('app/Models/Post.ts')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('includes uncommitted modifications to tracked files', async () => {
    const workspace = await createTempWorkspace('guren-cli-changed-modified-')
    try {
      await initRepo(workspace.dir)
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Models/Post.ts'), 'export class Post {}', 'utf8')
      await git(workspace.dir, ['add', '.'])
      await git(workspace.dir, ['commit', '-m', 'init'])

      await writeFile(join(workspace.dir, 'app/Models/Post.ts'), 'export class Post { extra = 1 }', 'utf8')

      const result = await getChangedFiles(workspace.dir)
      expect(result).not.toBeNull()
      expect(result!.has('app/Models/Post.ts')).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not report untouched committed files', async () => {
    const workspace = await createTempWorkspace('guren-cli-changed-untouched-')
    try {
      await initRepo(workspace.dir)
      await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
      await writeFile(join(workspace.dir, 'app/Models/Post.ts'), 'export class Post {}', 'utf8')
      await writeFile(join(workspace.dir, 'app/Models/User.ts'), 'export class User {}', 'utf8')
      await git(workspace.dir, ['add', '.'])
      await git(workspace.dir, ['commit', '-m', 'init'])

      await writeFile(join(workspace.dir, 'app/Models/Post.ts'), 'export class Post { extra = 1 }', 'utf8')

      const result = await getChangedFiles(workspace.dir)
      expect(result).not.toBeNull()
      expect(result!.has('app/Models/Post.ts')).toBe(true)
      expect(result!.has('app/Models/User.ts')).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })
})
