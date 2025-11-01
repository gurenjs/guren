import { startInertiaClient } from '@guren/inertia-client'

startInertiaClient({
  resolve: (name) => import(`./pages/${name}.tsx`),
})
