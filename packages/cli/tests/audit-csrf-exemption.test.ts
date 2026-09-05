import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import type { AuditFinding } from '../src/audit'
import { auditCsrfExemptions } from '../src/csrf-exemption-audit'
import { CAN_DENY_FILE_READS, writeInstalledPackage } from './helpers'

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
    await writeInstalledPackage(name, pkg.manifest, pkg.files, cwd)
  }

  return cwd
}

const GUREN_FACING = { dependencies: { '@guren/core': '^2.0.0' } }
const DECLARING_SOURCE = 'app.declareCookielessAuthPath(config.path);\n'
const DECLARES = { 'dist/index.js': DECLARING_SOURCE }

function chunks(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`dist/chunk-${i}.js`, 'export {}\n']))
}

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
        files: { 'dist/index.js': "export * from './chunk.js'\n", 'dist/chunk.js': DECLARING_SOURCE },
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
    expect(findings.some((f) => f.key.startsWith('csrf-scan:unreadable:'))).toBe(false)
  })

  it('reports a package too large to walk as partial coverage, not as declaring nothing', async () => {
    const cwd = await appWith({ 'acme-huge': { manifest: GUREN_FACING, files: chunks(401) } })
    const findings: AuditFinding[] = []

    const scan = await auditCsrfExemptions(cwd, findings)

    expect(scan.status).toBe('partial')
    expect(scan.declaredBy).toEqual([])
    expect(findings.find((f) => f.key === 'csrf-scan:truncated:acme-huge')?.status).toBe('warn')
  })

  it('does not call a package truncated when every file it ships was read', async () => {
    const cwd = await appWith({ 'acme-exact': { manifest: GUREN_FACING, files: chunks(400) } })
    const findings: AuditFinding[] = []

    expect((await auditCsrfExemptions(cwd, findings)).status).toBe('complete')
    expect(findings.some((f) => f.key.startsWith('csrf-scan:truncated:'))).toBe(false)
  })

  it('still reports partial when the package it truncated also declares one', async () => {
    const cwd = await appWith({
      'acme-huge': { manifest: GUREN_FACING, files: { ...chunks(401), ...DECLARES } },
    })
    const findings: AuditFinding[] = []

    const scan = await auditCsrfExemptions(cwd, findings)

    expect(scan.status).toBe('partial')
    expect(findings.find((f) => f.key === 'csrf-scan:truncated:acme-huge')?.status).toBe('warn')
  })

  it('does not read a mention of the method as a call', async () => {
    const cwd = await appWith({
      // The shape @guren/cli itself ships: this scanner's own constant, plus a
      // message naming the method. Neither is a call.
      'acme-tooling': {
        manifest: GUREN_FACING,
        files: {
          'dist/bin.js':
            'const DECLARE_CALL = "declareCookielessAuthPath";\n'
            + 'const msg = "exempts a path via declareCookielessAuthPath().";\n',
        },
      },
    })
    const findings: AuditFinding[] = []

    const scan = await auditCsrfExemptions(cwd, findings)

    expect(scan.packagesScanned).toBe(1)
    expect(scan.declaredBy).toEqual([])
  })

  it('matches optional-call and computed access, which a bundle can emit', async () => {
    const cwd = await appWith({
      'acme-optional': {
        manifest: GUREN_FACING,
        files: { 'dist/index.js': 'app.declareCookielessAuthPath?.(p)\n' },
      },
      'acme-computed': {
        manifest: GUREN_FACING,
        files: { 'dist/index.js': 'app["declareCookielessAuthPath"](p)\n' },
      },
    })
    const findings: AuditFinding[] = []

    expect((await auditCsrfExemptions(cwd, findings)).declaredBy.sort()).toEqual([
      'acme-computed',
      'acme-optional',
    ])
  })

  it('judges first-party by the published name, not by an npm: alias key', async () => {
    const cwd = await appWith({
      '@guren/plugin-mcp': {
        manifest: { name: 'acme-impostor', ...GUREN_FACING },
        files: DECLARES,
      },
    })
    const findings: AuditFinding[] = []

    const scan = await auditCsrfExemptions(cwd, findings)

    expect(scan.declaredBy).toEqual(['acme-impostor'])
    expect(findings.find((f) => f.key === 'csrf-exemption:plugin')?.status).toBe('warn')
  })

  it('counts a package listed in two dependency fields once', async () => {
    const cwd = await appWith({ 'acme-mcp': { manifest: GUREN_FACING, files: DECLARES } })
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { 'acme-mcp': '*' }, optionalDependencies: { 'acme-mcp': '*' } }),
    )
    const findings: AuditFinding[] = []

    const scan = await auditCsrfExemptions(cwd, findings)

    expect(scan.declaredBy).toEqual(['acme-mcp'])
    expect(scan.packagesScanned).toBe(1)
  })

  it('scans a plugin declared under optionalDependencies', async () => {
    const cwd = await appWith({ 'acme-mcp': { manifest: GUREN_FACING, files: DECLARES } })
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({ optionalDependencies: { 'acme-mcp': '*' } }),
    )
    const findings: AuditFinding[] = []

    expect((await auditCsrfExemptions(cwd, findings)).declaredBy).toEqual(['acme-mcp'])
  })

  it('treats a manifest that will not parse as unreadable, not as irrelevant', async () => {
    const cwd = await appWith({ 'acme-broken': { manifest: GUREN_FACING } })
    await writeFile(join(cwd, 'node_modules/acme-broken/package.json'), '{ not json')
    const findings: AuditFinding[] = []

    const scan = await auditCsrfExemptions(cwd, findings)

    expect(scan.status).toBe('partial')
    expect(findings.find((f) => f.key === 'csrf-scan:unreadable:acme-broken')?.status).toBe('warn')
  })

  it.skipIf(!CAN_DENY_FILE_READS)('reports an unreadable package as partial coverage rather than a clean scan', async () => {
    const cwd = await appWith({
      'acme-mcp': { manifest: GUREN_FACING, files: DECLARES },
    })
    await chmod(join(cwd, 'node_modules'), 0o000)
    const findings: AuditFinding[] = []

    const scan = await auditCsrfExemptions(cwd, findings)

    expect(scan.status).toBe('partial')
    expect(findings.find((f) => f.key === 'csrf-scan:unreadable:acme-mcp')?.status).toBe('warn')
  })
})
