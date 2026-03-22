import type { Page } from '@inertiajs/core'
import { renderInertiaServer } from '@guren/inertia-client'
import type { InertiaSsrContext, InertiaSsrResult } from '@guren/core'
import { pageManifest } from '../../.guren/pages.gen.ts'

let pages: Record<string, () => Promise<unknown>> | undefined

try {
  pages = import.meta.glob('./pages/**/*.tsx')
} catch {
  pages = undefined
}

export default async function renderSsr(context: InertiaSsrContext): Promise<InertiaSsrResult> {
  return renderInertiaServer({
    page: context.page as Page,
    pages,
    pageManifest,
    resolve: pages
      ? undefined
      : (name) => import(pageManifest[name as keyof typeof pageManifest] ?? `./pages/${name}.tsx`),
  })
}
