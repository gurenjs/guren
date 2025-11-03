import { Controller as BaseController, type InertiaResponse } from '@guren/server'

export default class Controller extends BaseController {
  protected async inertiaWithAuth<Component extends string, Props extends Record<string, unknown>>(
    component: Component,
    props: Props,
    options: Parameters<BaseController['inertia']>[2] = {},
  ): Promise<InertiaResponse<Component, Props & { auth: AuthPayload }>> {
    const user = await this.auth.user()
    const existingAuth = (props as { auth?: Record<string, unknown> }).auth
    const authProps: AuthPayload = {
      ...(typeof existingAuth === 'object' && existingAuth !== null ? existingAuth : {}),
      user,
    }

    const propsWithAuth: Props & { auth: AuthPayload } = { ...props, auth: authProps }

    return super.inertia(component, propsWithAuth, options)
  }
}

type AuthPayload = Record<string, unknown> & { user: unknown }
