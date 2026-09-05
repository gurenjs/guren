import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import type { AuditFinding } from '../src/audit'
import { auditCsrfExemptions } from '../src/csrf-exemption-audit'

const created: string[] = []

afterEach(async () => {
  for (const dir of created.splice(0)) {
    await chmod(join(dir, 'node_modules'), 0o755).catch(() => {})
    await rm(dir, { recursive: true, force: true })
  }
})

interface FakePackage {
  manifest: Record<string, unknown>
  /** Files under the package directory, by relative path. */
  files?: Record<string, string>
}

async function appWith(packages: Record<string, FakePackage>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'guren-csrf-exemption-'))
  created.push(cwd)

  await writeFile(
    join(cwd, 'package.json'),
    JSON.stringify({ dependencies: Object.fromEntries(Object.keys(packages).map((n) => [n, '*'])) }),
  )

  for (const [name, pkg] of Object.entries(packages)) {
    const dir = join(cwd, 'node_modules', name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, ...pkg.manifest }))
    for (const [relative, source] of Object.entries(pkg.files ?? {})) {
      await mkdir(join(dir, relative, '..'), { recursive: true })
      await writeFile(join(dir, relative), source)
    }
  }

  return cwd
}

const GUREN_FACING = { dependencies: { '@guren/core': '^2.0.0' } }
const DECLARES = { 'dist/index.js': 'app.declareCookielessAuthPath(config.path);\n' }

describe('auditCsrfExemptions', () => {
  it('passes when no Guren-facing package declares one', async () => {
    const cwd = await appWith({
      '@guren/plugin-quiet': { manifest: GUREN_FACING, files: { 'dist/index.js': 'export {}\n' } },
    })
    const findings: AuditFinding[] = []

    const scan = await auditCsrfExemptions(cwd, findings)

    expect(scan).toEqual({ status: 'complete', packagesScanned: 1, declaredBy: [] })
    expect(findings.find((f) => f.key === 'csrf-exemption:plugin')?.status).toBe('pass')
  })

  it('names a first-party declarer without warning: this repo reviews its own', async () => {
    const cwd = await appWith({
      '@guren/plugin-mcp': { manifest: GUREN_FACING, files: DECLARES },
    })
    const findings: AuditFinding[] = []

    const scan = await auditCsrfExemptions(cwd, findings)

    expect(scan.declaredBy).toEqual(['@guren/plugin-mcp'])
    expect(findings.find((f) => f.key === 'csrf-exemption:plugin')?.status).toBe('pass')
  })

  it('warns when a third-party package declares one', async () => {
    const cwd = await appWith({
      'acme-mcp': { manifest: GUREN_FACING, files: DECLARES },
    })
    const findings: AuditFinding[] = []

    const scan = await auditCsrfExemptions(cwd, findings)

    expect(scan.declaredBy).toEqual(['acme-mcp'])
    const finding = findings.find((f) => f.key === 'csrf-exemption:plugin')
    expect(finding?.status).toBe('warn')
    expect(finding?.message).toContain('acme-mcp')
  })

  it('finds the call in a chunk the entry point never names', async () => {
    const cwd = await appWith({
      'acme-mcp': {
        manifest: GUREN_FACING,
        files: { 'dist/index.js': "export * from './chunk.js'\n", 'dist/chunk.js': DECLARES['dist/index.js'] },
      },
    })
    const findings: AuditFinding[] = []

    expect((await auditCsrfExemptions(cwd, findings)).declaredBy).toEqual(['acme-mcp'])
  })

  it('reads a plugin identified by its gurenPlugin manifest alone', async () => {
    const cwd = await appWith({
      'acme-mcp': { manifest: { gurenPlugin: { compatibility: '>=2.0.0' } }, files: DECLARES },
    })
    const findings: AuditFinding[] = []

    expect((await auditCsrfExemptions(cwd, findings)).declaredBy).toEqual(['acme-mcp'])
  })

  it('does not walk a dependency with no relationship to Guren', async () => {
    const cwd = await appWith({
      react: { manifest: { dependencies: {} }, files: DECLARES },
    })
    const findings: AuditFinding[] = []

    const scan = await auditCsrfExemptions(cwd, findings)

    expect(scan.packagesScanned).toBe(0)
    expect(scan.declaredBy).toEqual([])
  })

  it('treats a declared-but-uninstalled dependency as nothing to scan, not a failure', async () => {
    const cwd = await appWith({})
    await writeFile(join(cwd, 'package.json'), JSON.stringify({ dependencies: { 'acme-mcp': '*' } }))
    const findings: AuditFinding[] = []

    expect((await auditCsrfExemptions(cwd, findings)).status).toBe('complete')
    expect(findings.some((f) => f.key.startsWith('csrf-exemption:unreadable:'))).toBe(false)
  })

  it('reports a package too large to walk as partial coverage, not as declaring nothing', async () => {
    const cwd = await appWith({
      'acme-huge': {
        manifest: GUREN_FACING,
        files: Object.fromEntries(
          Array.from({ length: 401 }, (_, i) => [`dist/chunk-${i}.js`, 'export {}\n']),
        ),
      },
    })
    const findings: AuditFinding[] = []

    const scan = await auditCsrfExemptions(cwd, findings)

    expect(scan.status).toBe('partial')
    expect(scan.declaredBy).toEqual([])
    expect(findings.find((f) => f.key === 'csrf-exemption:truncated:acme-huge')?.status).toBe('warn')
  })

  it('reports an unreadable package as partial coverage rather than a clean scan', async () => {
    const cwd = await appWith({
      'acme-mcp': { manifest: GUREN_FACING, files: DECLARES },
    })
    await chmod(join(cwd, 'node_modules'), 0o000)
    const findings: AuditFinding[] = []

    const scan = await auditCsrfExemptions(cwd, findings)

    expect(scan.status).toBe('partial')
    expect(findings.find((f) => f.key === 'csrf-exemption:unreadable:acme-mcp')?.status).toBe('warn')
  })
})
