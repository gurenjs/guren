import { readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const DEFAULT_MAX_KB = 450

interface BudgetCheckResult {
  target: string
  largestFile: string | null
  largestSizeKb: number
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(2)} kB`
}

async function collectJsAssets(directory: string): Promise<Array<{ file: string; size: number }>> {
  const entries = await readdir(directory, { withFileTypes: true })
  const assets: Array<{ file: string; size: number }> = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) {
      continue
    }

    const filePath = join(directory, entry.name)
    const { size } = await stat(filePath)
    assets.push({ file: filePath, size })
  }

  return assets
}

async function checkTarget(target: string, maxKb: number): Promise<BudgetCheckResult> {
  const resolvedTarget = resolve(target)
  const assetsDir = join(resolvedTarget, 'public/assets')
  const jsAssets = await collectJsAssets(assetsDir)

  if (jsAssets.length === 0) {
    throw new Error(`No built JavaScript assets found in ${assetsDir}. Run the app build first.`)
  }

  const largest = jsAssets.reduce((current, asset) => (asset.size > current.size ? asset : current))
  const largestSizeKb = largest.size / 1024

  if (largestSizeKb > maxKb) {
    throw new Error(
      `Build budget exceeded for ${resolvedTarget}: ${largest.file} is ${formatKb(largest.size)} (max ${maxKb.toFixed(2)} kB).`,
    )
  }

  return {
    target: resolvedTarget,
    largestFile: largest.file,
    largestSizeKb,
  }
}

function parseArgs(argv: string[]): { maxKb: number; targets: string[] } {
  const targets: string[] = []
  let maxKb = DEFAULT_MAX_KB

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--max-kb') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('Missing value for --max-kb.')
      }
      maxKb = Number(value)
      index += 1
      continue
    }

    targets.push(arg)
  }

  if (!Number.isFinite(maxKb) || maxKb <= 0) {
    throw new Error(`Invalid --max-kb value: ${String(maxKb)}`)
  }

  if (targets.length === 0) {
    targets.push('examples/blog', 'web')
  }

  return { maxKb, targets }
}

async function main(): Promise<void> {
  const { maxKb, targets } = parseArgs(process.argv.slice(2))
  const results = await Promise.all(targets.map((target) => checkTarget(target, maxKb)))

  for (const result of results) {
    console.log(
      `Build budget passed for ${result.target}: ${result.largestFile ? `${result.largestFile} (${result.largestSizeKb.toFixed(2)} kB)` : 'no assets found'}`,
    )
  }
}

await main()
