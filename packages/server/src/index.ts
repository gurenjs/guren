import { ensureErrorStackTracePolyfill } from './support/error-polyfill'

ensureErrorStackTracePolyfill()

export { Application } from './http/Application'
export type { Context, ApplicationListenOptions, ServiceProviderConstructor } from './http/Application'
export { registerDevAssets } from './http/dev-assets'
export { logDevServerBanner } from './http/dev-banner'
export type { DevBannerOptions } from './http/dev-banner'
export { GUREN_ASCII_ART } from './http/dev-banner'
export { startViteDevServer } from './http/vite-dev-server'
export type { StartViteDevServerOptions, StartedViteDevServer } from './http/vite-dev-server'
export { configureInertiaAssets, autoConfigureInertiaAssets } from './http/inertia-assets'
export type { AutoConfigureInertiaOptions } from './http/inertia-assets'
export { parseRequestPayload, formatValidationErrors } from './http/request'
export { Controller } from './mvc/Controller'
export type { InertiaResponse, InferInertiaProps, ControllerInertiaProps, AuthPayload } from './mvc/Controller'
export { Route } from './mvc/Route'
export type { RouteBuilder, RouteDefinition, ResourceAction as RouteResourceAction, ResourceRouteOptions } from './mvc/Route'
export { ViewEngine } from './mvc/ViewEngine'
export { inertia } from './mvc/inertia/InertiaEngine'
export { setInertiaSharedProps } from './mvc/inertia/shared'
export type {
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
// Legacy plugin system (deprecated - use container ServiceProvider instead)
export type { Provider, ProviderConstructor } from './plugins/Provider'
export { ApplicationContext } from './plugins/ApplicationContext'
export { InertiaViewProvider as LegacyInertiaViewProvider } from './plugins/providers/InertiaViewProvider'
export { AuthServiceProvider as LegacyAuthServiceProvider } from './plugins/providers/AuthServiceProvider'
// New container-based providers
export {
  InertiaServiceProvider,
  AuthServiceProvider,
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
  MemoryApiTokenStore,
  API_TOKEN_KEY,
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
} from './http/middleware'
export { gurenVitePlugin } from './vite/plugin'
export type { GurenVitePluginOptions } from './vite/plugin'
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
  RedisDriver,
  setQueueDriver,
  getQueueDriver,
  registerJob,
  getJob,
  getRegisteredJobs,
  clearJobRegistry,
  createQueueManager,
  processJob,
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
  PaginationMeta,
  PaginationLinks,
  PaginatedResponse,
  CursorPaginationMeta,
  CursorPaginatedResponse,
  PaginatorOptions,
  CursorPaginatorOptions,
  ResourceClass,
  BaseResource,
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
} from './notifications'
export type {
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
} from './container'
export type {
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
  createEncrypter,
  setEncrypter,
  getEncrypter,
  encrypt,
  decrypt,
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
  EncryptOptions,
  DecryptOptions,
  EncrypterConfig,
  EncryptedPayload,
  HashAlgorithm,
  HmacOptions,
  PasswordHashOptions,
  RandomStringOptions,
} from './encryption'
// Facades (prefixed to avoid conflicts with class exports)
export {
  Cache as CacheFacade,
  Events as EventsFacade,
  Queue as QueueFacade,
  Mail as MailFacade,
  Log as LogFacade,
  I18n as I18nFacade,
  Notifications as NotificationsFacade,
  Broadcast as BroadcastFacade,
  Storage as StorageFacade,
  Scheduler as SchedulerFacade,
  createFacade,
} from './facades'
// Auto-Discovery
export { AutoDiscovery } from './discovery'
export type { DiscoveryOptions, DiscoveryResult } from './discovery'
// Debug Error Page
export { renderDebugPage, debugErrorMiddleware } from './errors/debug-page'
