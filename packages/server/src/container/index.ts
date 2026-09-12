export type {
  ContainerLike,
  ServiceFactory,
  ServiceClass,
  ServiceBinding,
  ContextualBindingBuilder,
  ContextualNeedsBuilder,
  ContextualBinding,
  ServiceProviderOptions,
  Provider,
  ServiceProviderClass,
} from './types'

export type { ServiceBindings } from './bindings'

export {
  Container,
  createContainer,
  setContainer,
  getContainer,
} from './Container'

// From the default application, not the raw slot, so every ambient resolution
// answers by one rule (RFC 0023 §3).
export { resolve } from '../http/default-application'

export { resolveOptional } from './resolve-optional'

export { ServiceProvider, ProviderManager } from './ServiceProvider'

export { definePlugin } from './definePlugin'
export type { PluginDefinition, PluginFactory } from './definePlugin'

export { defineModule, mountModuleRoutes } from './defineModule'
export type { ModuleDefinition, GurenModule } from './defineModule'
