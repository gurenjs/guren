/**
 * Fail the deploy when the worker bundle outgrows its budget. Runs wrangler's
 * dry run on the assembled .cloudflare/ (so after `cloudflare:build`, before
 * anything touches D1) and reads the size it reports. Needs no credentials.
 *   bun scripts/check-bundle-size.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { judgeBundleSize, parseWranglerSize } from './lib/bundle-size.js'

const outDir = mkdtempSync(join(tmpdir(), 'guren-web-bundle-'))
let exitCode = 1

try {
  const child = Bun.spawn(['bunx', 'wrangler', 'deploy', '--dry-run', '--outdir', outDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0) {
    console.error(`wrangler deploy --dry-run exited ${code}\n${stderr}${stdout}`)
  } else {
    const size = parseWranglerSize(`${stdout}\n${stderr}`)
    if (!size) {
      console.error(`wrangler printed no "Total Upload" line to read the size from:\n${stderr}${stdout}`)
    } else {
      const verdict = judgeBundleSize(size)
      console.log(verdict.message)
      exitCode = verdict.ok ? 0 : 1
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

process.exit(exitCode)
