import { fileExists } from './discovery'

export interface InertiaPageRef {
  /** Page ID relative to the pages directory, e.g. `posts/Index`. */
  id: string
  /** How the controller referenced it: a string literal or the typed `pages.*` manifest. */
  form: 'literal' | 'manifest'
}

const INERTIA_CALL_REGEX =
  /this\.inertia\(\s*(?:pages((?:\.\w+|\[['"][^'"]+['"]\])+)|['"]([^'"]+)['"])/g

const MANIFEST_SEGMENT_REGEX = /\.\w+|\[['"][^'"]+['"]\]/g

/**
 * Page references in a controller source via `this.inertia(...)` — the
 * string-literal form (`this.inertia('posts/Index')`) and the typed
 * manifest form (`this.inertia(pages.posts.Index)`, including bracket
 * segments like `pages['sales-admin'].Index`). Regex-based by design (the
 * same trade-off `guren check` has always made), so calls inside comments
 * can produce false positives. The single source of truth for "how a
 * controller references a page", shared by `guren check` and the entity
 * context.
 */
export function extractInertiaPageRefs(source: string): InertiaPageRef[] {
  const seen = new Set<string>()
  const refs: InertiaPageRef[] = []
  let match: RegExpExecArray | null
  while ((match = INERTIA_CALL_REGEX.exec(source)) !== null) {
    let id: string | undefined
    let form: InertiaPageRef['form']
    if (match[1]) {
      form = 'manifest'
      const segments = match[1].match(MANIFEST_SEGMENT_REGEX) ?? []
      id = segments
        .map((segment) => (segment.startsWith('.') ? segment.slice(1) : segment.slice(2, -2)))
        .join('/')
    } else {
      form = 'literal'
      id = match[2]
    }
    if (!id || seen.has(id)) continue
    seen.add(id)
    refs.push({ id, form })
  }
  return refs
}

/**
 * Component file for a page ID (`.tsx` then `.jsx`), relative to `cwd`, or
 * `undefined` when no file exists.
 */
export async function resolveInertiaPageFile(cwd: string, id: string): Promise<string | undefined> {
  for (const ext of ['tsx', 'jsx']) {
    const candidate = `resources/js/pages/${id}.${ext}`
    if (await fileExists(cwd, candidate)) {
      return candidate
    }
  }
  return undefined
}

/** The path a missing page component *should* live at — used in fix suggestions. */
export function expectedInertiaPagePath(id: string): string {
  return `resources/js/pages/${id}.tsx`
}
