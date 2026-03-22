import { setInertiaSharedProps, AUTH_CONTEXT_KEY, type AuthContext } from '@guren/core'

setInertiaSharedProps(async (ctx) => {
  const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined

  return {
    auth: {
      user: await auth?.user(),
    },
  }
})
