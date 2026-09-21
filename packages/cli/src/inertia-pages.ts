import { extname, resolve, relative } from 'node:path'
import { fileExists, collectFiles } from './discovery'
import { extractPagePropKeys, extractPageProps, type PagePropKeys } from './page-props-extractor'

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
 * The one rule for how a controller references a page, shared by `guren check`
 * and the entity context: the string-literal and typed-manifest forms of
 * `this.inertia(...)`, including bracket segments (`pages['sales-admin']`).
 * Regex-based by design, so a call inside a comment is a false positive unless the
 * caller passes `isCode`, which is asked about the offset each match starts at.
 */
export function extractInertiaPageRefs(source: string, isCode?: (index: number) => boolean): InertiaPageRef[] {
  const seen = new Set<string>()
  const refs: InertiaPageRef[] = []
  let match: RegExpExecArray | null
  while ((match = INERTIA_CALL_REGEX.exec(source)) !== null) {
    if (isCode && !isCode(match.index)) continue
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
 * The extensions a page component may have: the scaffolded client entry globs the
 * pages directory for `.tsx`, and codegen registers `.tsx` and `.jsx` in
 * `.guren/pages.gen.ts`. A `.ts` or `.js` file there is not a page the app can
 * render, and listing it would have `check`, `context`, `spec:generate` and
 * `plan:status` claim a page the client cannot load.
 */
export const PAGE_COMPONENT_EXTENSIONS = new Set(['.tsx', '.jsx'])

/**
 * Component file for a page ID, relative to `cwd`. Probes
 * {@link PAGE_COMPONENT_EXTENSIONS} in insertion order, so a `.tsx` wins over a
 * `.jsx` of the same ID.
 */
export async function resolveInertiaPageFile(cwd: string, id: string): Promise<string | undefined> {
  for (const extension of PAGE_COMPONENT_EXTENSIONS) {
    const candidate = `resources/js/pages/${id}${extension}`
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

export interface InertiaPageDescription {
  id: string
  /** Component file relative to the app root; absent when no file exists. */
  filePath?: string
  /** Props type collapsed to one line, when extractable. */
  props?: string
}

/**
 * The projection shared by the entity context's Pages section and the screens
 * spec view: a page ID resolved to its component file and one-line Props type.
 */
export async function describeInertiaPage(cwd: string, id: string): Promise<InertiaPageDescription> {
  const filePath = await resolveInertiaPageFile(cwd, id)
  if (!filePath) return { id }

  let props: string | undefined
  try {
    const extracted = await extractPageProps(resolve(cwd, filePath), id)
    props = extracted.rawType?.replace(/\s+/g, ' ').trim()
  } catch {
    // Unparsable page — still list it, just without props.
  }

  return { id, filePath, props }
}

/**
 * The prop keys a page declares, or null when the page has no component file. A parse or
 * read failure is `unreadable`: a caller comparing keys must not take it for "no props".
 */
export async function describeInertiaPagePropKeys(cwd: string, id: string): Promise<PagePropKeys | null> {
  const filePath = await resolveInertiaPageFile(cwd, id)
  if (!filePath) return null

  try {
    return await extractPagePropKeys(resolve(cwd, filePath))
  } catch (error) {
    return { status: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Page IDs for every component file under `resources/js/pages`, sorted,
 * excluding the shared `contracts/` types directory.
 */
export async function listInertiaPageIds(cwd: string): Promise<string[]> {
  const pagesDir = resolve(cwd, 'resources/js/pages')
  const files = await collectFiles(pagesDir, PAGE_COMPONENT_EXTENSIONS)
  return files
    .map((file) => {
      const path = relative(pagesDir, file).split(/[\\/]/).join('/')
      return path.slice(0, path.length - extname(path).length)
    })
    .filter((id) => !id.startsWith('contracts'))
    .sort()
}
