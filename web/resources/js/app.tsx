import { router } from '@inertiajs/react'
import '../css/app.css'
import { LIGHT_SURFACE_BODY_CLASS, usesLightSurface } from '../../config/theme.js'

// The server puts this class on <body> for the initial document; client-side
// visits never re-render it, so mirror the same rule here. Driving it from
// `usesLightSurface` — the predicate the server uses too — keeps one list of
// light-surface pages instead of a hook call each page has to remember.
router.on('navigate', (event: { detail: { page: { component: string } } }) => {
  document.body.classList.toggle(
    LIGHT_SURFACE_BODY_CLASS,
    usesLightSurface(event.detail.page.component),
  )
})

let pages: Record<string, () => Promise<unknown>> | undefined

try {
  pages = import.meta.glob('./pages/**/*.tsx')
} catch {
  pages = undefined
}

void import('@guren/inertia-client').then(({ startInertiaClient }) =>
  startInertiaClient({
    pages,
    resolve: pages ? undefined : (name) => import(`./pages/${name}.tsx`),
  }),
)
