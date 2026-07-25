export function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/**
 * Derive a unique slug from a title, probing existing slugs through the
 * injected `isTaken` check (`my-post`, `my-post-2`, `my-post-3`, ...).
 */
export async function uniqueSlug(
  title: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const base = slugify(title) || 'post'
  let candidate = base
  for (let suffix = 2; await isTaken(candidate); suffix += 1) {
    candidate = `${base}-${suffix}`
  }
  return candidate
}
