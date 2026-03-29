import '../css/app.css'
import { pageManifest } from '../../.guren/pages.gen.ts'

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
      : (name) => import(/* @vite-ignore */ pageManifest[name as keyof typeof pageManifest] ?? `./pages/${name}.tsx`),
  }),
)
