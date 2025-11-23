import { renderInertiaServer } from '@guren/inertia-client'
import type { InertiaSsrContext, InertiaSsrResult } from '@guren/server'

let pages: Record<string, () => Promise<unknown>> | undefined
type InertiaPage = Parameters<typeof renderInertiaServer>[0]['page']

try {
  pages = import.meta.glob('./pages/**/*.tsx')
} catch {
  pages = undefined
}

export default async function renderSsr(context: InertiaSsrContext): Promise<InertiaSsrResult> {
  return renderInertiaServer({
    page: context.page as InertiaPage,
    pages,
    resolve: pages ? undefined : (name) => import(`./pages/${name}.tsx`),
  })
}
