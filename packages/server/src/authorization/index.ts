export type {
  AuthUser,
  GateCallback,
  GateDefinition,
  PolicyMethod,
  PolicyResult,
  Policy as PolicyInterface,
  PolicyClass,
  AuthorizationResponse,
  GateOptions,
  AuthorizeOptions,
  PolicyRegistration,
  ResourceAction,
  ResponseBuilder,
} from './types'

export {
  Gate,
  Response,
  isAuthorizationResponse,
  createGate,
  setGate,
  getGate,
  defineGate,
  can,
  cannot,
  authorize,
} from './Gate'

export { Policy, definePolicy } from './Policy'

export {
  authorizeMiddleware,
  authorizeAllMiddleware,
  authorizeResourceMiddleware,
  withAuthorization,
} from './middleware'

export type { AuthorizedContext } from './middleware'
