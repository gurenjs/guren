import { defineNavigation } from '@guren/core'

// The layout's links: each entry names a GET route and says who sees it. The
// server sends a page only the entries its user may see. A route's middleware,
// not a hidden link, is what keeps a page private.
export default defineNavigation([
  { label: 'Home', route: 'home' },
  { label: 'Dashboard', route: 'dashboard', show: { auth: 'required' } },
])
