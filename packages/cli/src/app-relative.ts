/**
 * Backslashes count as separators and a drive letter is absolute, as Windows `path.resolve`
 * treats them: a `..\..\outside.md` judged by `/` rules alone slips past containment. Doc links
 * and a lesson's `enforcedBy` both start here, so they cannot disagree about what is inside the app.
 */
export function normalizeTarget(target: string): { path: string; absolute: boolean } {
  const path = target.replace(/\\/g, '/')
  return { path, absolute: path.startsWith('/') || /^[A-Za-z]:/.test(path) }
}

/** App-root-relative: no absolute path and no `..` segment, which would reach files outside the project. */
export function isAppRootRelative(entry: string): boolean {
  const { path, absolute } = normalizeTarget(entry)
  return !absolute && !path.split('/').includes('..')
}
