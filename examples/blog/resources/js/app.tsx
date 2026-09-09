import '../css/app.css'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '@guren/inertia-client'
import { pageManifest } from '@/.guren/pages.gen'

let pages: Record<string, () => Promise<unknown>> | undefined

try {
  // Vite transforms this call to eagerly register matching page modules.
  pages = import.meta.glob!('./pages/**/*.tsx')
} catch {
  pages = undefined
}

void import('@guren/inertia-client').then(({ startInertiaClient }) =>
  startInertiaClient({
    pages,
    pageManifest,
    // `vite --mode prototype` defines GUREN_PROTOTYPE as `true`; in every
    // other build it is the literal `false`, so this branch and its import are
    // dropped from the bundle (RFC 0021).
    prototype: import.meta.env.GUREN_PROTOTYPE
      ? { load: () => import('./prototype/index.js'), base: import.meta.env.BASE_URL }
      : undefined,
    resolve: pages
      ? undefined
      : (name) => import(/* @vite-ignore */ pageManifest[name as keyof typeof pageManifest] ?? `./pages/${name}.tsx`),
    setup({ el, App, props }) {
      createRoot(el).render(
        React.createElement(ErrorBoundary, null,
          React.createElement(App, props as any),
        ),
      )
    },
  }),
)
