import { setInertiaSharedProps, AUTH_CONTEXT_KEY, getCsrfToken, type AuthContext } from '@guren/core'

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
