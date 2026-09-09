/**
 * The size of the worker wrangler would upload, and where it comes from.
 * wrangler's dry run does the bundling and esbuild's metafile the attribution,
 * so the numbers are the ones a deploy produces. The platform limit is 64 MiB
 * uncompressed on every plan since 2026-09-04, when Cloudflare dropped the
 * compressed limits (3 MB Free / 10 MB Paid); it is held in one place below
 * with its source and the date it was confirmed, because a number that moved
 * once will move again. Startup time and isolate memory are not measured here.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

export const WORKER_SIZE_LIMIT = {
  bytes: 64 * 1024 * 1024,
  source: 'https://developers.cloudflare.com/workers/platform/limits/#worker-size',
  confirmedOn: '2026-09-09',
} as const

/** Share of the limit at which the report turns into a warning. */
export const WORKER_SIZE_WARN_SHARE = 0.5

export interface BundleSize {
  totalBytes: number
  gzipBytes: number | null
}

const UNIT_BYTES: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 * 1024 }

function toBytes(value: string, unit: string): number {
  return Math.round(Number.parseFloat(value) * UNIT_BYTES[unit]!)
}

/** wrangler prints `Total Upload: 4931.18 KiB / gzip: 899.63 KiB`; the unit is its choice. */
export function parseWranglerSize(output: string): BundleSize | null {
  const total = output.match(/Total Upload:\s*([\d.]+)\s*(B|KiB|MiB)/u)
  if (!total) {
    return null
  }
  const gzip = output.match(/gzip:\s*([\d.]+)\s*(B|KiB|MiB)/u)

  return {
    totalBytes: toBytes(total[1]!, total[2]!),
    gzipBytes: gzip ? toBytes(gzip[1]!, gzip[2]!) : null,
  }
}

/** The part of esbuild's metafile this reads. */
export interface EsbuildMetafile {
  outputs: Record<string, { bytes: number; inputs: Record<string, { bytesInOutput: number }> }>
}

export interface BundleAttribution {
  /** A package name, or a path relative to the app root for the app's own files. */
  name: string
  bytes: number
}

export interface AttributeOptions {
  root: string
  /** Where wrangler ran, which the metafile's input paths are relative to. Defaults to `root`. */
  cwd?: string
  /** The package an absolute file belongs to, or null for the app's own code. */
  packageNameOf?: (file: string) => string | null
}

/**
 * The nearest *named* package.json above the file that is not the app's own.
 * Handles node_modules, bun's `.bun/<pkg>@<version>/node_modules/<pkg>` layout
 * and workspace siblings alike, since each carries a manifest. A nameless one
 * (zod's `v4/package.json` holds only `type`) is passed over. Cached per
 * directory: a bundle has hundreds of inputs in a few dozen directories.
 */
export function createPackageNameResolver(root: string): (file: string) => string | null {
  const rootDir = resolve(root)
  const byDir = new Map<string, string | null>()

  const lookup = (dir: string): string | null => {
    const cached = byDir.get(dir)
    if (cached !== undefined) {
      return cached
    }

    let name: string | null = null
    if (dir !== rootDir) {
      const manifest = join(dir, 'package.json')
      const named = existsSync(manifest) ? readPackageName(manifest) : undefined
      const parent = dirname(dir)
      name = named ?? (parent === dir ? null : lookup(parent))
    }

    byDir.set(dir, name)
    return name
  }

  return (file) => lookup(dirname(resolve(file)))
}

function readPackageName(manifest: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
    return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined
  } catch {
    return undefined
  }
}

/** Every input's bytes in the bundle, summed per package, largest first. */
export function attributeBundle(metafile: EsbuildMetafile, options: AttributeOptions): BundleAttribution[] {
  const root = resolve(options.root)
  const cwd = resolve(options.cwd ?? root)
  const packageNameOf = options.packageNameOf ?? createPackageNameResolver(root)

  // The worker is the output with inputs; a source map has none.
  const bundle = Object.values(metafile.outputs).reduce<EsbuildMetafile['outputs'][string] | undefined>(
    (best, output) =>
      best === undefined || Object.keys(output.inputs).length > Object.keys(best.inputs).length ? output : best,
    undefined,
  )
  if (!bundle) {
    return []
  }

  const bytesByName = new Map<string, number>()
  for (const [input, { bytesInOutput }] of Object.entries(bundle.inputs)) {
    const file = resolve(cwd, input)
    const name = packageNameOf(file) ?? relative(root, file)
    bytesByName.set(name, (bytesByName.get(name) ?? 0) + bytesInOutput)
  }

  return [...bytesByName.entries()]
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
}

export interface BundleReport {
  size: BundleSize
  attribution: BundleAttribution[]
  /** Uncompressed bytes over the platform limit. */
  share: number
  warn: boolean
  lines: string[]
}

export interface RenderOptions {
  /** How many sources to list. Defaults to 10. */
  top?: number
  limitBytes?: number
  warnShare?: number
}

function kib(bytes: number): string {
  return `${Math.round(bytes / 1024).toLocaleString('en-US')} KiB`
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`
}

export function renderBundleReport(
  size: BundleSize,
  attribution: BundleAttribution[],
  options: RenderOptions = {},
): BundleReport {
  const limitBytes = options.limitBytes ?? WORKER_SIZE_LIMIT.bytes
  const share = size.totalBytes / limitBytes
  const warn = share >= (options.warnShare ?? WORKER_SIZE_WARN_SHARE)
  const gzip = size.gzipBytes === null ? '' : ` (gzip ${kib(size.gzipBytes)})`

  const lines = [
    `Worker bundle: ${kib(size.totalBytes)} uncompressed${gzip}, ${percent(share)} of the ${Math.round(limitBytes / 1024 / 1024)} MiB platform limit`
      + ` (uncompressed; ${WORKER_SIZE_LIMIT.source}, confirmed ${WORKER_SIZE_LIMIT.confirmedOn}).`,
  ]

  const top = attribution.slice(0, options.top ?? 10)
  if (top.length > 0) {
    lines.push('Largest sources:')
    const width = Math.max(...top.map((entry) => kib(entry.bytes).length))
    for (const entry of top) {
      lines.push(`  ${kib(entry.bytes).padStart(width)}  ${percent(entry.bytes / size.totalBytes).padStart(6)}  ${entry.name}`)
    }
  }
  lines.push(
    'Not measured here: startup time (1 s; `wrangler check startup`) and memory (128 MB per isolate).',
  )

  return { size, attribution, share, warn, lines }
}

export interface ReportBundleSizeOptions {
  /** The app root holding wrangler.jsonc and the assembled .cloudflare/. */
  root: string
  top?: number
}

/**
 * Run wrangler's dry run on the assembled output and read what it would
 * upload. Needs no credentials. The metafile goes to a temporary directory
 * because wrangler writes it beside the bundle, and the bundle must not land
 * in the app: `.cloudflare/` is what the deploy reads.
 */
export function reportBundleSize(options: ReportBundleSizeOptions): BundleReport {
  const root = resolve(options.root)
  const outDir = mkdtempSync(join(tmpdir(), 'guren-cf-size-'))
  const metafile = join(outDir, 'meta.json')

  try {
    const result = Bun.spawnSync({
      cmd: ['bunx', 'wrangler', 'deploy', '--dry-run', '--outdir', outDir, '--metafile', metafile],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const output = `${result.stdout.toString()}${result.stderr.toString()}`
    if (result.exitCode !== 0) {
      throw new Error(`Cloudflare size: wrangler deploy --dry-run exited ${result.exitCode}.\n${output}`)
    }

    const size = parseWranglerSize(output)
    if (!size) {
      throw new Error(`Cloudflare size: wrangler printed no "Total Upload" line to read the size from.\n${output}`)
    }

    const attribution = existsSync(metafile)
      ? attributeBundle(JSON.parse(readFileSync(metafile, 'utf8')) as EsbuildMetafile, { root })
      : []

    return renderBundleReport(size, attribution, { top: options.top })
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
}

/** The report on stdout, and the threshold crossing on stderr where a CI log highlights it. */
export function printBundleReport(report: BundleReport): void {
  for (const line of report.lines) {
    console.log(line)
  }
  if (report.warn) {
    console.warn(
      `Cloudflare size: the worker bundle is ${percent(report.share)} of the platform limit. `
        + 'The largest sources above are where to look; generated content belongs in Workers Static Assets, KV or R2 rather than in the bundle.',
    )
  }
}
