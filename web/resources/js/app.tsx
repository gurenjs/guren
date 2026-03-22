import '../css/app.css'

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
