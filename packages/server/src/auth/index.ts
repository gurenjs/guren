export { AuthManager } from './AuthManager'
export type { ApiTokenGuardOptions } from './AuthManager'
export { SessionGuard } from './SessionGuard'
export { TokenGuard } from './TokenGuard'
export type { TokenGuardOptions } from './TokenGuard'
export { BaseUserProvider } from './providers/UserProvider'
export { ModelUserProvider } from './providers/ModelUserProvider'
export { ScryptHasher } from './password/ScryptHasher'
export { NodeHasher } from './password/NodeHasher'
export { AuthenticatableModel } from './AuthenticatableModel'
export {
  createPasswordResetToken,
  verifyPasswordResetToken,
  completePasswordReset,
  buildPasswordResetUrl,
  parsePasswordResetUrl,
  MemoryPasswordResetStore,
} from './password-reset'
export {
  createEmailVerificationToken,
  verifyEmailToken,
  completeEmailVerification,
  buildVerificationUrl,
  parseVerificationUrl,
  isEmailVerified,
  requireVerifiedEmail,
  MemoryEmailVerificationStore,
} from './email-verification'
export type { PasswordHasher } from './password/PasswordHasher'
export type {
  PasswordResetConfig,
  PasswordResetTokenStore,
  PasswordResetTokenResult,
} from './password-reset'
export type {
  EmailVerificationConfig,
  EmailVerificationTokenStore,
  EmailVerificationToken,
  EmailVerificationTokenResult,
} from './email-verification'
export {
  createApiToken,
  parseApiToken,
  readBearerToken,
  verifyApiToken,
  tokenCan,
  tokenCanAll,
  tokenCanAny,
  revokeApiToken,
  revokeAllApiTokens,
  getUserApiTokens,
  createBearerTokenMiddleware,
  getApiToken,
  getApiTokenOrFail,
  MemoryApiTokenStore,
  API_TOKEN_KEY,
} from './api-token'
export {
  OAuthManager,
  MemoryOAuthStateStore,
  createOAuthManager,
  createOAuthState,
  verifyOAuthState,
  buildOAuthAuthorizeUrl,
  exchangeOAuthCode,
  fetchOAuthUserProfile,
  createGitHubOAuthProviderConfig,
  createGoogleOAuthProviderConfig,
  createDiscordOAuthProviderConfig,
  buildOAuthRedirectUrl,
  parseOAuthRedirectUrl,
  sanitizeOAuthRedirect,
  OAUTH_SESSION_BINDING_KEY,
} from './oauth'
export type {
  ApiToken,
  ApiTokenStore,
  CreateApiTokenOptions,
  CreateApiTokenResult,
  BearerTokenMiddlewareOptions,
  VerifiedApiToken,
} from './api-token'
export type {
  OAuthProviderConfig,
  OAuthTokenResult,
  OAuthUserProfile,
  OAuthFallbackEmail,
  OAuthStatePayload,
  OAuthStateStore,
  OAuthStateConfig,
  OAuthAuthorizeOptions,
  OAuthCallbackPayload,
  OAuthManagerOptions,
  OAuthProviderFactoryInput,
  OAuthBindingSession,
} from './oauth'
export type {
  AuthContext,
  AuthCredentials,
  AuthManagerOptions,
  AuthManagerContract,
  Authenticatable,
  Guard,
  GuardContext,
  GuardFactory,
  UserProvider,
  ProviderFactory,
  AttachContextOptions,
  DefaultSanitizedKeys,
  Sanitized,
} from './types'
export {
  hashToken,
  generateToken,
  generateId,
  secureCompare,
  secureStringCompare,
  buildTokenUrl,
  parseTokenUrl,
} from './utils'
