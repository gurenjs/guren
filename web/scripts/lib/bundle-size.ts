// The worker bundle budget the deploy enforces (scripts/check-bundle-size.ts).
// A regression budget, not the platform's number: Cloudflare checks 64 MiB
// uncompressed on every plan (developers.cloudflare.com/workers/platform/limits,
// confirmed 2026-09-09; the compressed limits went away on 2026-09-04). The
// worker measured 4,935 KiB after #758, and 28,622 KiB with the docs bundled
// in, which nothing reported. Raise the budget deliberately, with the number
// that justified it.

export const BUNDLE_BUDGET_KIB = 12_288

export interface BundleSize {
  totalKiB: number
  gzipKiB: number | null
}

export function judgeBundleSize(
  size: BundleSize,
  budgetKiB = BUNDLE_BUDGET_KIB,
): { ok: boolean; message: string } {
  const percent = ((size.totalKiB / budgetKiB) * 100).toFixed(0)
  const gzip = size.gzipKiB === null ? '' : ` (gzip ${size.gzipKiB.toFixed(0)} KiB)`
  const ok = size.totalKiB <= budgetKiB
  const line = `Worker bundle: ${size.totalKiB.toFixed(0)} KiB uncompressed${gzip}, ${percent}% of the ${budgetKiB} KiB budget.`

  return {
    ok,
    message: ok
      ? line
      : `${line}\nOver budget. The largest sources above are where to look, ` +
        'or raise BUNDLE_BUDGET_KIB in web/scripts/lib/bundle-size.ts with the number that justifies it.',
  }
}
