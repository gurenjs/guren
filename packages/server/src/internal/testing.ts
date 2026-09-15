/**
 * The framework classes and helpers `@guren/testing`'s controller mock installs as its own
 * exports. A mock that suites install as `@guren/server` itself cannot import
 * that specifier (the factory would be mocking what it imports), so it reaches
 * the same modules through this deep import; `instanceof` then agrees with the runtime.
 * Internal per `contributing/api-stability.md`: reachable only through this path.
 */
export { Resource, JsonResource, collect } from '../http/resources/Resource'
export { ValidationException } from '../errors/exceptions/ValidationException'
export { AuthenticationException } from '../errors/exceptions/AuthenticationException'
export { ServiceProvider } from '../container/ServiceProvider'
export { defineModule } from '../container/defineModule'
export { definePlugin } from '../container/definePlugin'
export { formatValidationErrors } from '../http/request'
