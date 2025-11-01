import { Controller as BaseController } from '@guren/server'

export default class Controller extends BaseController {
  protected async inertiaWithAuth<Component extends string, Props extends Record<string, unknown>>(
    component: Component,
    props: Props,
    options: Parameters<BaseController['inertia']>[2] = {},
  ) {
    const user = await this.auth.user()
    const existingAuth = (props as { auth?: Record<string, unknown> }).auth
    const authProps = {
      ...(typeof existingAuth === 'object' && existingAuth !== null ? existingAuth : {}),
      user,
    }

    return super.inertia(component, { ...props, auth: authProps }, options)
  }
}
