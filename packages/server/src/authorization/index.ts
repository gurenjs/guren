export type {
  AuthUser,
  GateCallback,
  GateDefinition,
  PolicyMethod,
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
