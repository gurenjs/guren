import React from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from '@guren/inertia-client'
import { pageManifest } from '@/.guren/pages.gen'
import '../css/app.css'

let pages: Record<string, () => Promise<unknown>> | undefined

try {
  pages = import.meta.glob!('./pages/**/*.tsx')
} catch {
  pages = undefined
}

void import('@guren/inertia-client').then(({ startInertiaClient }) =>
  startInertiaClient({
    pages,
    pageManifest,
    resolve: pages
      ? undefined
      : (name) =>
          import(/* @vite-ignore */ pageManifest[name as keyof typeof pageManifest] ?? `./pages/${name}.tsx`),
    setup({ el, App, props }) {
      createRoot(el).render(
        React.createElement(ErrorBoundary, null, React.createElement(App, props as any)),
      )
    },
  }),
)
