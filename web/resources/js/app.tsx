import '../css/app.css'
import { startInertiaClient } from '@guren/inertia-client'

let pages: Record<string, () => Promise<unknown>> | undefined

try {
  pages = import.meta.glob!('./pages/**/*.tsx')
} catch {
  pages = undefined
}

startInertiaClient({
  pages,
  resolve: pages ? undefined : (name) => import(`./pages/${name}.tsx`),
})
