import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attributeBundle,
  createPackageNameResolver,
  parseWranglerSize,
  renderBundleReport,
  reportBundleSize,
  WORKER_SIZE_LIMIT,
  type EsbuildMetafile,
} from './bundle-size'

const temps: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('parseWranglerSize', () => {
  test('should read the uncompressed and gzip sizes wrangler prints', () => {
    expect(parseWranglerSize('Total Upload: 4931.18 KiB / gzip: 899.63 KiB\n--dry-run: exiting now.')).toEqual({
      totalBytes: Math.round(4931.18 * 1024),
      gzipBytes: Math.round(899.63 * 1024),
    })
  })

  test('should convert whichever unit wrangler chose', () => {
    expect(parseWranglerSize('Total Upload: 1.5 MiB / gzip: 512 B')).toEqual({
      totalBytes: 1.5 * 1024 * 1024,
      gzipBytes: 512,
    })
  })

  test('should return null when the line is absent', () => {
    expect(parseWranglerSize('nothing here')).toBeNull()
  })
})

describe('createPackageNameResolver', () => {
  test('should name the package a file belongs to, and null for the app itself', () => {
    const root = tempDir('guren-cf-size-root-')
    writeFileSync(join(root, 'package.json'), '{"name":"my-app"}')
    mkdirSync(join(root, 'node_modules/@scope/pkg/dist'), { recursive: true })
    writeFileSync(join(root, 'node_modules/@scope/pkg/package.json'), '{"name":"@scope/pkg"}')
    mkdirSync(join(root, 'node_modules/.bun/plain@1.0.0/node_modules/plain/dist'), { recursive: true })
    writeFileSync(join(root, 'node_modules/.bun/plain@1.0.0/node_modules/plain/package.json'), '{"name":"plain"}')
    mkdirSync(join(root, 'node_modules/zod/v4/core'), { recursive: true })
    writeFileSync(join(root, 'node_modules/zod/package.json'), '{"name":"zod"}')
    // A subpath manifest carrying only `type`, as zod ships: not the package.
    writeFileSync(join(root, 'node_modules/zod/v4/package.json'), '{"type":"module"}')
    mkdirSync(join(root, 'src'), { recursive: true })

    const nameOf = createPackageNameResolver(root)

    expect(nameOf(join(root, 'node_modules/@scope/pkg/dist/index.js'))).toBe('@scope/pkg')
    expect(nameOf(join(root, 'node_modules/.bun/plain@1.0.0/node_modules/plain/dist/a.js'))).toBe('plain')
    expect(nameOf(join(root, 'node_modules/zod/v4/core/schemas.js'))).toBe('zod')
    expect(nameOf(join(root, 'src/app.ts'))).toBeNull()
    expect(nameOf(join(root, '.guren/ssr/chunk.js'))).toBeNull()
  })
})

describe('attributeBundle', () => {
  const metafile: EsbuildMetafile = {
    outputs: {
      'out/worker.js.map': { bytes: 10, inputs: {} },
      'out/worker.js': {
        bytes: 1000,
        inputs: {
          'src/app.ts': { bytesInOutput: 100 },
          '.guren/docs.gen.ts': { bytesInOutput: 500 },
          '../node_modules/zod/a.js': { bytesInOutput: 150 },
          '../node_modules/zod/b.js': { bytesInOutput: 150 },
          '../node_modules/hono/index.js': { bytesInOutput: 100 },
        },
      },
    },
  }

  test('should sum inputs per package and list the app files by relative path, largest first', () => {
    const root = '/app'
    const attribution = attributeBundle(metafile, {
      root,
      packageNameOf: (file) => {
        const match = file.match(/node_modules\/([^/]+)\//u)
        return match ? match[1]! : null
      },
    })

    expect(attribution).toEqual([
      { name: '.guren/docs.gen.ts', bytes: 500 },
      { name: 'zod', bytes: 300 },
      { name: 'hono', bytes: 100 },
      { name: 'src/app.ts', bytes: 100 },
    ])
  })

  test('should return nothing for a metafile without a bundle', () => {
    expect(attributeBundle({ outputs: {} }, { root: '/app', packageNameOf: () => null })).toEqual([])
  })
})

describe('renderBundleReport', () => {
  const attribution = [
    { name: '.guren/docs.gen.ts', bytes: 23_789 * 1024 },
    { name: 'zod', bytes: 773 * 1024 },
  ]

  test('should state the share of the platform limit with its source and date', () => {
    const report = renderBundleReport({ totalBytes: 4931 * 1024, gzipBytes: 900 * 1024 }, attribution)

    expect(report.warn).toBe(false)
    expect(report.lines[0]).toBe(
      `Worker bundle: 4,931 KiB uncompressed (gzip 900 KiB), 7.5% of the 64 MiB platform limit (uncompressed; ${WORKER_SIZE_LIMIT.source}, confirmed ${WORKER_SIZE_LIMIT.confirmedOn}).`,
    )
    expect(report.lines).toContain('Largest sources:')
    expect(report.lines.some((line) => line.endsWith('.guren/docs.gen.ts'))).toBe(true)
    expect(report.lines.at(-1)).toContain('wrangler check startup')
  })

  test('should warn from half the limit upward', () => {
    expect(renderBundleReport({ totalBytes: 32 * 1024 * 1024, gzipBytes: null }, []).warn).toBe(true)
    expect(renderBundleReport({ totalBytes: 32 * 1024 * 1024 - 1, gzipBytes: null }, []).warn).toBe(false)
  })

  test('should list only the requested number of sources', () => {
    const report = renderBundleReport({ totalBytes: 1024, gzipBytes: null }, attribution, { top: 1 })

    expect(report.lines.filter((line) => line.startsWith('  ')).length).toBe(1)
  })
})

// Opt-in: runs wrangler's dry run (downloads wrangler and esbuild) on a
// one-file worker. Gated behind GUREN_TEST_WRANGLER=1 and skipped in CI.
describe.skipIf(process.env.GUREN_TEST_WRANGLER !== '1')('reportBundleSize against wrangler', () => {
  test('should measure the bundle and attribute it to the worker source', () => {
    const root = tempDir('guren-cf-size-e2e-')
    writeFileSync(join(root, 'package.json'), '{"name":"size-probe"}')
    writeFileSync(
      join(root, 'wrangler.jsonc'),
      JSON.stringify({ name: 'size-probe', main: 'worker.js', compatibility_date: '2026-07-01' }),
    )
    writeFileSync(join(root, 'worker.js'), 'export default { fetch() { return new Response("ok") } }\n')

    const report = reportBundleSize({ root })

    expect(report.size.totalBytes).toBeGreaterThan(0)
    expect(report.attribution.map((entry) => entry.name)).toContain('worker.js')
    expect(report.warn).toBe(false)
  }, 120_000)
})
