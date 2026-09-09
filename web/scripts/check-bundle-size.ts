/**
 * Fail the deploy when the worker bundle outgrows its budget. The plugin's
 * report does the measuring (wrangler's dry run on the assembled .cloudflare/,
 * attributed through esbuild's metafile), so the deploy log also shows where
 * the bytes come from; the budget and the verdict are this app's. Runs after
 * `cloudflare:build`, before anything touches D1. Needs no credentials.
 *   bun scripts/check-bundle-size.ts
 */
import { fileURLToPath } from 'node:url'

import { printBundleReport, reportBundleSize } from '@guren/plugin-cloudflare'

import { judgeBundleSize } from './lib/bundle-size.js'

const report = reportBundleSize({ root: fileURLToPath(new URL('..', import.meta.url)) })
printBundleReport(report)

const verdict = judgeBundleSize({
  totalKiB: report.size.totalBytes / 1024,
  gzipKiB: report.size.gzipBytes === null ? null : report.size.gzipBytes / 1024,
})
console.log(verdict.message)
process.exit(verdict.ok ? 0 : 1)
