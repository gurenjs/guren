import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { runAudit } from '../src/audit'
import { createTempWorkspace } from './helpers'

async function writeRoutes(dir: string): Promise<void> {
  await mkdir(join(dir, 'routes'), { recursive: true })
  await writeFile(
    join(dir, 'routes/web.ts'),
    `class UploadController {
  async store() { return null }
}
export default function registerRoutes(router: any) {
  router.post('/uploads', [UploadController, 'store'])
}`,
    'utf8',
  )
}

async function writeController(dir: string, body: string): Promise<void> {
  await mkdir(join(dir, 'app/Http/Controllers'), { recursive: true })
  await writeFile(
    join(dir, 'app/Http/Controllers/UploadController.ts'),
    `export default class UploadController {
  async store() {
${body}
  }
}`,
    'utf8',
  )
}

describe('runAudit — uploads through the attachments pipeline', () => {
  it('passes when the only body reads are uploads handed to a typed attach()', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-attach-pass-')
    try {
      await writeController(
        workspace.dir,
        `    const cover = await this.file('cover')
    if (cover) {
      await Post.attach(1, 'cover', cover)
    }
    return null`,
      )
      await writeRoutes(workspace.dir)

      const report = await runAudit({ cwd: workspace.dir })

      const validation = report.findings.find((f) => f.key === 'validation:POST /uploads')
      expect(validation).toBeDefined()
      expect(validation!.status).toBe('pass')
      expect(validation!.message).toContain('attach()')
    } finally {
      await workspace.cleanup()
    }
  })

  it('still fails when the action also reads non-file body input', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-attach-mixed-')
    try {
      await writeController(
        workspace.dir,
        `    const title = await this.input<string>('title')
    const cover = await this.file('cover')
    await Post.attach(1, 'cover', cover)
    return null`,
      )
      await writeRoutes(workspace.dir)

      const report = await runAudit({ cwd: workspace.dir })

      const validation = report.findings.find((f) => f.key === 'validation:POST /uploads')
      expect(validation!.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  it('still fails when uploads are stored without a typed attach()', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-attach-raw-')
    try {
      await writeController(
        workspace.dir,
        `    const cover = await this.file('cover')
    await storage.disk().put('uploads/cover.png', Buffer.from(await cover.arrayBuffer()))
    return null`,
      )
      await writeRoutes(workspace.dir)

      const report = await runAudit({ cwd: workspace.dir })

      const validation = report.findings.find((f) => f.key === 'validation:POST /uploads')
      expect(validation!.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  it('still fails when the method also writes to storage directly', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-attach-put-')
    try {
      await writeController(
        workspace.dir,
        `    const cover = await this.file('cover')
    await Post.attach(1, 'cover', somethingElse)
    await storage.disk().put('raw/cover.bin', Buffer.from(await cover.arrayBuffer()))
    return null`,
      )
      await writeRoutes(workspace.dir)

      const report = await runAudit({ cwd: workspace.dir })

      // Co-occurrence is not data flow: a raw put() beside the attach()
      // may be storing the unvalidated upload, so the pass is withheld.
      const validation = report.findings.find((f) => f.key === 'validation:POST /uploads')
      expect(validation!.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  it('counts request.arrayBuffer() as an unvalidated body read', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-arraybuffer-')
    try {
      await writeController(
        workspace.dir,
        `    const raw = await this.request.arrayBuffer()
    return null`,
      )
      await writeRoutes(workspace.dir)

      const report = await runAudit({ cwd: workspace.dir })

      const validation = report.findings.find((f) => f.key === 'validation:POST /uploads')
      expect(validation!.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not count a lowercase attach() receiver as validation', async () => {
    const workspace = await createTempWorkspace('guren-cli-audit-attach-lowercase-')
    try {
      await writeController(
        workspace.dir,
        `    const cover = await this.file('cover')
    emitter.attach(cover)
    return null`,
      )
      await writeRoutes(workspace.dir)

      const report = await runAudit({ cwd: workspace.dir })

      const validation = report.findings.find((f) => f.key === 'validation:POST /uploads')
      expect(validation!.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })
})
