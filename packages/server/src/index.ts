import { ensureErrorStackTracePolyfill } from './support/error-polyfill'

ensureErrorStackTracePolyfill()

export { Application, createApp } from './http/Application'
export type { Context, ApplicationListenOptions, ServiceProviderConstructor } from './http/Application'
export { parseRequestPayload, formatValidationErrors } from './http/request'
export { Controller } from './mvc/Controller'
export type { InertiaResponse, InferInertiaProps, ControllerInertiaProps, AuthPayload } from './mvc/Controller'
export { Router } from './mvc/Router'
export type {
  RouteBuilder,
  RouteContractOptions,
  RouteDefinition,
  RouteMiddlewareInput,
  RouteOpenApiMetadata,
  ResourceAction as RouteResourceAction,
  ResourceRouteOptions,
} from './mvc/Router'
export { ViewEngine } from './mvc/ViewEngine'
export { inertia, setInertiaSsrRenderer, setInertiaDocument } from './mvc/inertia/InertiaEngine'
export { setInertiaSharedProps, getInertiaSharedPropsResolver, shareInertiaProps } from './mvc/inertia/shared'
export type {
  InertiaDocumentContext,
  InertiaDocumentOptions,
  InertiaOptions,
  InertiaPagePayload,
  InertiaSsrContext,
  InertiaSsrOptions,
  InertiaSsrRenderer,
  InertiaSsrResult,
} from './mvc/inertia/InertiaEngine'
export type {
  SharedInertiaPropsResolver,
  InertiaSharedProps,
  ResolvedSharedInertiaProps,
} from './mvc/inertia/shared'
// Service Providers
export {
  InertiaServiceProvider,
  AuthServiceProvider,
  OAuthServiceProvider,
  EventServiceProvider,
  CacheServiceProvider,
  QueueServiceProvider,
  MailServiceProvider,
  LogServiceProvider,
  I18nServiceProvider,
  NotificationServiceProvider,
  BroadcastServiceProvider,
  EncryptionServiceProvider,
  StorageServiceProvider,
  HealthServiceProvider,
  SchedulingServiceProvider,
  AuthorizationServiceProvider,
  ErrorServiceProvider,
} from './providers'
// FormRequest
export { FormRequest } from './http/FormRequest'
export {
  AuthManager,
  SessionGuard,
  ModelUserProvider,
  BaseUserProvider,
  AuthenticatableModel,
  ScryptHasher,
  createPasswordResetToken,
  verifyPasswordResetToken,
  completePasswordReset,
  buildPasswordResetUrl,
  parsePasswordResetUrl,
  MemoryPasswordResetStore,
  // Email verification
  createEmailVerificationToken,
  verifyEmailToken,
  completeEmailVerification,
  buildVerificationUrl,
  parseVerificationUrl,
  isEmailVerified,
  requireVerifiedEmail,
  MemoryEmailVerificationStore,
  // API tokens
  createApiToken,
  parseApiToken,
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
  OAuthManager,
  MemoryOAuthStateStore,
  createOAuthManager,
  createOAuthState,
  verifyOAuthState,
  sanitizeOAuthRedirect,
  buildOAuthAuthorizeUrl,
  exchangeOAuthCode,
  fetchOAuthUserProfile,
  createGitHubOAuthProviderConfig,
  createGoogleOAuthProviderConfig,
  createDiscordOAuthProviderConfig,
  buildOAuthRedirectUrl,
  parseOAuthRedirectUrl,
}
  from './auth'
export type {
  AuthContext as AuthRuntimeContext,
  AuthCredentials,
  AuthManagerOptions,
  Authenticatable,
  Guard,
  GuardContext,
  GuardFactory,
  UserProvider,
  ProviderFactory,
  DefaultSanitizedKeys,
  Sanitized,
  PasswordResetConfig,
  PasswordResetTokenStore,
  PasswordResetTokenResult,
  // Email verification types
  EmailVerificationConfig,
  EmailVerificationTokenStore,
  EmailVerificationToken,
  EmailVerificationTokenResult,
  // API token types
  ApiToken,
  ApiTokenStore,
  CreateApiTokenOptions,
  CreateApiTokenResult,
  BearerTokenMiddlewareOptions,
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
} from './auth'
export {
  defineMiddleware,
  jsonResponse,
  createSessionMiddleware,
  MemorySessionStore,
  getSessionFromContext,
  requireAuthenticated,
  requireGuest,
  attachAuthContext,
  createCsrfMiddleware,
  getCsrfToken,
  csrfField,
  verifyCsrfToken,
  CSRF_TOKEN_KEY,
  CSRF_HEADER_NAME,
  CSRF_FORM_FIELD,
  validateRequest,
  validateRequestWith,
  getValidatedData,
  validate,
  validateSafe,
  VALIDATED_DATA_KEY,
  // Rate limiting
  createRateLimitMiddleware,
  getRateLimitInfo,
  resetRateLimit,
  MemoryRateLimitStore,
  SlidingWindowRateLimitStore,
  // Security headers
  createSecurityHeaders,
  // CSP
  createCspMiddleware,
  getCspNonce,
  CSP_NONCE_KEY,
  // Host authorization
  createHostAuthorizationMiddleware,
  // CORS
  createCorsMiddleware,
  // Redirect safety
  createRedirectSafetyMiddleware,
  isSafeRedirectUrl,
  // Force HTTPS
  createForceHttpsMiddleware,
  // Request ID & Logging
  requestIdMiddleware,
  requestLoggingMiddleware,
  // Locale detection
  detectLocaleMiddleware,
  LOCALE_CONTEXT_KEY,
  getRequestLocale,
  getRequestTranslator,
}
  from './http/middleware'
export { AUTH_CONTEXT_KEY } from './http/middleware/auth'
export type {
  Middleware,
  Session,
  SessionData,
  SessionStore,
  AuthContext,
  RequireAuthOptions,
  CsrfOptions,
  ValidationSchema,
  ValidateRequestOptions,
  // Rate limiting types
  RateLimitOptions,
  RateLimitStore,
  RateLimitEntry,
  RateLimitInfo,
  // Security headers types
  SecurityHeadersOptions,
  HstsOptions,
  // CSP types
  CspOptions,
  CspDirectives,
  // Host authorization types
  HostAuthorizationOptions,
  // CORS types
  CorsOptions,
  // Redirect safety types
  RedirectSafetyOptions,
  // Force HTTPS types
  ForceHttpsOptions,
  // Locale detection types
  DetectLocaleOptions,
  DetectLocaleVariables,
  TranslatorBinding,
  LocaleSource,
}  from './http/middleware'
// Validation (advanced)
export {
  Validator,
  FieldValidator,
  createValidator,
  quickValidate,
  quickValidateOrThrow,
  // Rules
  required,
  nullable,
  requiredIf,
  requiredUnless,
  requiredWith,
  requiredWithout,
  string as stringRule,
  numeric,
  integer,
  boolean as booleanRule,
  array as arrayRule,
  object as objectRule,
  email as emailRule,
  url as urlRule,
  uuid as uuidRule,
  ip,
  ipv4,
  ipv6,
  json as jsonRule,
  alpha,
  alphaNum,
  alphaDash,
  regex,
  min,
  max,
  between,
  size,
  inValues,
  notIn,
  confirmed,
  same,
  different,
  date as dateRule,
  dateFormat,
  after,
  afterOrEqual,
  before,
  beforeOrEqual,
  startsWith,
  endsWith,
  file as fileRule,
  image as imageRule,
  mimes,
  maxFileSize,
  minFileSize,
  custom,
  unique,
  exists,
} from './http/validation'
export type {
  ValidationRule,
  RuleDefinition,
  ValidationResult,
  FileValidationOptions,
  ImageValidationOptions,
  ValidatorOptions,
  FileLike,
} from './http/validation'
// Events
export {
  Event,
  EventManager,
  createEventManager,
  Listener,
  // Built-in events
  RequestReceived,
  RequestFinished,
  UserAuthenticated,
  UserLoggedOut,
  JobProcessed,
  JobFailed,
  ApplicationStarted,
  ApplicationShutdown,
} from './events'
export type {
  EventClass,
  EventListener,
  ListenerOptions,
  RegisteredListener,
  EventSubscription,
  ListenerClass,
} from './events'
// Queue
export {
  Job,
  Worker,
  QueueManager,
  MemoryDriver,
  SyncDriver,
  RedisDriver,
  MemoryDriver as MemoryQueueDriver,
  SyncDriver as SyncQueueDriver,
  RedisDriver as RedisQueueDriver,
  setQueueDriver,
  getQueueDriver,
  registerJob,
  getJob,
  getRegisteredJobs,
  clearJobRegistry,
  resolveJobName,
  createQueueManager,
  processJob,
  FailedJobReporter,
} from './queue'
export type {
  QueuedJob,
  FailedJob,
  QueueDriver,
  JobOptions,
  WorkerOptions,
  JobHandler,
  JobFailureHandler,
  JobClass,
  WorkerEvents,
  QueueConfig,
  QueueDriverFactory,
  RedisDriverOptions,
  FailedJobInfo,
  FailedJobHandler,
} from './queue'
// Mail
export {
  Mail,
  mail,
  MailManager,
  createMailManager,
  setMailManager,
  getMailManager,
  SmtpTransport,
  ResendTransport,
  MemoryTransport,
  LogTransport,
} from './mail'
export type {
  MailAddress,
  MailAttachment,
  MailMessage,
  SendResult,
  MailTransport,
  MailTransportFactory,
  MailTransportConfig,
  MailConfig,
  SmtpTransportOptions,
  ResendTransportOptions,
  MemoryTransportOptions,
} from './mail'
// Cache
export {
  CacheManager,
  MemoryStore as MemoryCacheStore,
  RedisStore as RedisCacheStore,
  FileStore as FileCacheStore,
  TaggedCache,
  createCacheManager,
} from './cache'
export type {
  CacheStore,
  CacheConfig,
  CacheStoreFactory,
} from './cache'
// Storage
export {
  StorageManager,
  LocalDriver as LocalStorageDriver,
  MemoryDriver as MemoryStorageDriver,
  S3Driver,
  createStorageManager,
} from './storage'
export type {
  StorageDriver,
  StorageConfig,
  DiskConfig,
  StorageDriverFactory,
  PutOptions,
  FileMetadata,
} from './storage'
// Scheduling
export {
  Scheduler,
  Schedule,
  PendingSchedule,
  ScheduledTask,
  parseCron,
  matchesCron,
  getNextOccurrence,
  getNextOccurrences,
  isDue,
  isDueInTimezone,
  toTimezone,
  createScheduler,
} from './scheduling'
export type {
  TaskCallback,
  TaskDefinition,
  SchedulerOptions,
  ParsedCron,
  JobClass as ScheduledJobClass,
} from './scheduling'
// Logging
export {
  Logger,
  filterSensitiveData,
  LogManager,
  ConsoleChannel,
  FileChannel,
  DailyFileChannel,
  LOG_LEVEL_PRIORITY,
  createLogManager,
  setLogManager,
  getLogManager,
} from './logging'
export type {
  LogLevel,
  LogContext,
  LogEntry,
  LogChannel,
  LogChannelFactory,
  LogChannelConfig,
  ConsoleChannelConfig,
  FileChannelConfig,
  DailyFileChannelConfig,
  StackChannelConfig,
  LogConfig,
  LogFormatter,
  LoggerOptions,
} from './logging'
// i18n
export {
  Translator,
  I18nManager,
  JsonLoader,
  MemoryLoader,
  pluralizationRules,
  getPluralizationRule,
  selectPluralForm,
  createI18n,
  setI18n,
  getI18n,
  tryGetI18n,
  t,
  tc,
} from './i18n'
export type {
  TranslationMessages,
  ReplacementValues,
  PluralizationRule,
  TranslationLoader,
  TranslatorOptions,
  I18nConfig,
  TranslationLoaderFactory,
} from './i18n'
// Database (Seeder & Factory)
export {
  BaseSeeder,
  Seeder,
  resetCalledSeeders,
  BaseFactory,
  Factory,
  defineFactory,
  SeederRunner,
  createSeederRunner,
} from './database'
export type {
  SeederClass,
  SeederInterface,
  FactoryClass,
  FactoryInterface,
  SeederRunnerOptions,
} from './database'
// API Resources
export {
  Resource,
  JsonResource,
  collect,
  ResourceCollection,
  Paginator,
  paginate,
  CursorPaginator,
  cursorPaginate,
  encodeCursor,
  decodeCursor,
} from './http/resources'
export type {
  ResourceData,
  ValidationErrors,
  PaginationMeta,
  PaginationLinks,
  PaginationPageLink,
  PaginatedResponse,
  PaginatedPageProps,
  PaginatedResultLike,
  CursorPaginationMeta,
  CursorPaginatedResponse,
  PaginatorOptions,
  CursorPaginatorOptions,
  ResourceClass,
  BaseResource,
  InferResourceData,
} from './http/resources'
// Health Checks
export {
  HealthCheck,
  HealthManager,
  createHealthManager,
  DatabaseCheck,
  RedisCheck,
  CacheCheck,
  StorageCheck,
  MemoryCheck,
  CustomCheck,
  customCheck,
} from './health'
export type {
  HealthStatus,
  CheckResult,
  HealthReport,
  HealthCheckOptions,
  HealthMiddlewareOptions,
  DatabaseConnection,
  DatabaseCheckOptions,
  RedisClient,
  RedisCheckOptions,
  CacheStoreInterface,
  CacheCheckOptions,
  StorageDriverInterface,
  StorageCheckOptions,
  MemoryCheckOptions,
  CustomCheckCallback,
} from './health'
// Notifications
export {
  Notification,
  NotificationManager,
  createNotificationManager,
  setNotificationManager,
  getNotificationManager,
  MailChannel,
  DatabaseChannel,
  SlackChannel,
  MemoryChannel,
  registerNotification,
  getNotification,
  clearNotificationRegistry,
  resolveNotifiableType,
} from './notifications'
export type {
  NotificationConstructor,
  NotificationChannel,
  Notifiable,
  DatabaseNotification,
  NotificationMailMessage,
  NotificationAttachment,
  SlackMessage,
  SlackBlock,
  SlackAttachment,
  NotificationChannelFactory,
  NotificationManagerOptions,
  DatabaseChannelOptions,
  SentNotification,
  NotificationClass,
  MailChannelOptions,
  SlackChannelOptions,
} from './notifications'
// Broadcasting
export {
  BroadcastManager,
  createBroadcastManager,
  setBroadcastManager,
  getBroadcastManager,
  Channel,
  PrivateChannel,
  PresenceChannel,
  MemoryDriver as MemoryBroadcastDriver,
  RedisDriver as RedisBroadcastDriver,
} from './broadcasting'
export type {
  BroadcastEvent,
  BroadcastDriver,
  PresenceBroadcastDriver,
  ChannelAuthorizer,
  PresenceChannelAuthorizer,
  PresenceMember,
  SSEClient,
  WebSocketClient,
  BroadcastManagerOptions,
  BroadcastDriverFactory,
  ChannelRegistration,
  SSEMiddlewareOptions,
  AuthMiddlewareOptions,
  BroadcastableEvent,
  RedisClient as BroadcastRedisClient,
  RedisDriverOptions as BroadcastRedisDriverOptions,
} from './broadcasting'
// Container
export {
  Container,
  createContainer,
  setContainer,
  getContainer,
  resolve,
  ServiceProvider,
  ProviderManager,
  definePlugin,
  defineModule,
  mountModuleRoutes,
} from './container'
export type {
  PluginDefinition,
  PluginFactory,
  ModuleDefinition,
  GurenModule,
  ServiceFactory,
  ServiceClass,
  ServiceBinding,
  ServiceBindings,
  ContextualBindingBuilder,
  ContextualNeedsBuilder,
  ContextualBinding,
  ServiceProviderOptions,
  Provider as ContainerProvider,
  ServiceProviderClass,
} from './container'
// Errors
export {
  HttpException,
  ExceptionHandler,
  createExceptionHandler,
  setExceptionHandler,
  getExceptionHandler,
  abort,
  abortIf,
  abortUnless,
  ValidationException,
  AuthenticationException,
  AuthorizationException,
  NotFoundHttpException,
  MethodNotAllowedException,
} from './errors'
export type {
  ErrorResponse,
  ExceptionHandlerOptions,
  ExceptionReporter,
  ExceptionRenderer,
  ExceptionClass,
  RendererRegistration,
} from './errors'
// Console
export {
  Command,
  Input,
  Output,
  BufferedOutput,
  ConsoleKernel,
  createConsoleKernel,
  parseSignature,
} from './console'
export type {
  ArgumentDefinition,
  OptionDefinition,
  ParsedSignature,
  CommandClass,
  CommandInstance,
  ConsoleKernelOptions,
  OutputInterface,
  InputInterface,
  ScheduledCommand,
  PromptInterface,
  ProgressInterface,
} from './console'
// Authorization
export {
  Gate,
  Response as AuthResponse,
  createGate,
  setGate,
  getGate,
  defineGate,
  can,
  cannot,
  authorize as authorizeAbility,
  Policy,
  definePolicy,
  authorizeMiddleware,
  authorizeAllMiddleware,
  authorizeResourceMiddleware,
  withAuthorization,
} from './authorization'
export type {
  AuthUser,
  GateCallback,
  GateDefinition,
  PolicyMethod,
  PolicyInterface,
  PolicyClass,
  AuthorizationResponse,
  GateOptions,
  AuthorizeOptions,
  PolicyRegistration,
  ResourceAction,
  ResponseBuilder,
  AuthorizedContext,
} from './authorization'
// Encryption
export {
  Encrypter,
  generateKey,
  generateAppKey,
  normalizeAppKey,
  parseAppKey,
  parsePreviousAppKeys,
  getAppKeyringFromEnv,
  deriveAppKey,
  deriveAppKeyring,
  createEncrypter,
  setEncrypter,
  getEncrypter,
  encrypt,
  decrypt,
  MessageSigner,
  signUrl,
  verifySignedUrl,
  hash,
  hmac,
  verifyHmac,
  sha256,
  sha512,
  md5,
  hashPassword,
  verifyPassword,
  needsRehash,
  secureCompare,
  check as checkHash,
  randomString,
  random,
  randomHex,
  randomBase64,
  randomBase64Url,
  uuid,
  randomInt,
  urlSafeToken,
  generatePassword,
  generateOtp,
  generateSlug,
  shuffle,
  pick,
  sample,
} from './encryption'
export type {
  AppKeyring,
  EncryptOptions,
  DecryptOptions,
  EncrypterConfig,
  EncryptedPayload,
  SignedMessageClaims,
  SignMessageOptions,
  VerifySignedMessageOptions,
  HashAlgorithm,
  HmacOptions,
  PasswordHashOptions,
  RandomStringOptions,
  SignedUrlOptions,
  VerifySignedUrlOptions,
} from './encryption'
// Facades
export { createFacade, createFacades } from './facades'
// Auto-Discovery
export { AutoDiscovery } from './discovery'
export type { DiscoveryOptions, DiscoveryResult } from './discovery'
// Debug Error Page
export { renderDebugPage, debugErrorMiddleware } from './errors/debug-page'
// Production Error Page
export { renderErrorPage } from './errors/error-page'
// Auth: Node.js-compatible hasher (for Lambda / non-Bun runtimes)
export { NodeHasher } from './auth/password/NodeHasher'
// Hash: convenience alias for ScryptHasher (used as default in docs)
export { DefaultHasher, DefaultHasher as Hash } from './auth/password/DefaultHasher'
export type { ApplicationOptions, AuthPluginOptions, I18nPluginOptions } from './http/Application'
export type { InertiaI18nProps } from './providers/I18nServiceProvider'
// Queue: SQS adapter
export { SqsDriver, createSqsAdapter } from './queue/drivers/SqsDriver'
// Broadcasting: typed broadcaster
export { createTypedBroadcaster } from './broadcasting/typed'
// Redis: client factory
export { createRedisClient } from './redis/client'
// MCP: available via '@guren/server/mcp' subpath import.
// Not re-exported here to avoid pulling @modelcontextprotocol/sdk
// types into the main DTS bundle (causes OOM in tsup).
// Docs viewer (RFC 0005): dev-only, loopback-guarded OKF bundle UI.
// Not re-exported here for the same reason as MCP above — `Application`
// mounts it by dynamic relative import, and nothing outside the package
// consumes it, so it stays internal rather than becoming public API.
