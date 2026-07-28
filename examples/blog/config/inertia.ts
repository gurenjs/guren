import {
  setInertiaSharedProps,
  setInertiaDocument,
  AUTH_CONTEXT_KEY,
  getCsrfToken,
  type AuthContext,
} from '@guren/core'

// Rendered into every server-rendered document. Replace public/favicon.svg
// with your own artwork, or add more tags here (Open Graph, apple-touch-icon).
setInertiaDocument({
  head: '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
})

setInertiaSharedProps(async (ctx) => {
  const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
  let csrfToken: string | undefined
  try {
    csrfToken = getCsrfToken(ctx)
  } catch {
    // Session not available (e.g., during SSR or non-session routes)
  }

  return {
    auth: {
      user: await auth?.user(),
    },
    csrfToken,
  }
})
