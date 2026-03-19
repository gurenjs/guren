# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### @guren/server

- **CSRF Protection**: New `createCsrfMiddleware()` factory for protecting against cross-site request forgery attacks
  - `getCsrfToken(ctx)` - Get the CSRF token for the current session
  - `csrfField(ctx)` - Generate a hidden input field with the CSRF token
  - `verifyCsrfToken(ctx, token)` - Manually verify a CSRF token
  - Configurable field name, header name, excluded routes, and error handling

- **Validation Pipeline**: New validation middleware with Zod-compatible schema support
  - `validateRequest(schema)` - Middleware factory for request validation
  - `validateRequestWith(schemaFactory)` - Dynamic schema based on request context
  - `getValidatedData(ctx)` - Retrieve validated and typed data
  - `validate(schema, data)` - Manual validation (throws on error)
  - `validateSafe(schema, data)` - Safe validation returning result object

- **Named Routes**: Routes can now be named for URL generation
  - `Route.get('/users/:id', handler).name('users.show')` - Assign names to routes
  - `Route.route('users.show', { id: 1 })` - Generate URLs from named routes
  - `Route.hasRoute(name)` - Check if a named route exists

- **Resource Routes**: RESTful resource route generation
  - `Route.resource('/posts', PostController)` - Generate all CRUD routes
  - Options: `only`, `except`, `param`, `name` for customization
  - Automatically names routes (e.g., `posts.index`, `posts.show`)

- **Password Reset**: Secure password reset token management
  - `createPasswordResetToken(email, store)` - Generate reset tokens
  - `verifyPasswordResetToken(token, store)` - Verify token validity
  - `completePasswordReset(token, password, store, provider, updateFn)` - Complete reset flow
  - `MemoryPasswordResetStore` - In-memory token storage for testing
  - `buildPasswordResetUrl()` / `parsePasswordResetUrl()` - URL helpers

- **Email Verification**: Complete email verification flow
  - `createEmailVerificationToken(email, store)` - Generate verification tokens
  - `verifyEmailToken(token, store)` - Verify token and return email
  - `completeEmailVerification(token, store, markVerified)` - Complete verification with callback
  - `requireVerifiedEmail(options)` - Middleware to protect routes
  - `isEmailVerified(user)` - Check if user email is verified
  - `MemoryEmailVerificationStore` - In-memory token storage for testing
  - `buildVerificationUrl()` / `parseVerificationUrl()` - URL helpers

- **Rate Limiting**: Request rate limiting middleware
  - `createRateLimitMiddleware(options)` - Middleware factory with configurable limits
  - `getRateLimitInfo(key, store)` - Get current rate limit status
  - `resetRateLimit(key, store)` - Reset rate limit for a key
  - `MemoryRateLimitStore` - Fixed-window rate limit store
  - `SlidingWindowRateLimitStore` - Sliding-window rate limit store
  - Configurable: limit, window, key prefix, skip function, headers, custom handlers

- **API Token Authentication**: Bearer token-based API authentication
  - `createApiToken(store, options)` - Create tokens with abilities/scopes
  - `verifyApiToken(plainTextToken, store)` - Verify and return token data
  - `tokenCan(token, ability)` / `tokenCanAll()` / `tokenCanAny()` - Check abilities
  - `revokeApiToken(id, store)` / `revokeAllApiTokens(userId, store)` - Token revocation
  - `getUserApiTokens(userId, store)` - List user's tokens
  - `createBearerTokenMiddleware(options)` - Middleware with ability requirements
  - `getApiToken(ctx)` - Get authenticated token from context
  - `MemoryApiTokenStore` - In-memory token storage for testing

- **Event System**: Application-wide event dispatcher
  - `Event` - Base class for defining custom events
  - `EventManager` - Central event manager with `on()`, `off()`, `emit()`, `once()`
  - `Listener` - Base class for class-based event listeners
  - Priority-based listener execution
  - Built-in events: `RequestReceived`, `RequestFinished`, `UserAuthenticated`, `UserLoggedOut`, `JobProcessed`, `JobFailed`, `ApplicationStarted`, `ApplicationShutdown`

- **Redis Stores**: Production-ready Redis implementations for all stores
  - `createRedisClient(options)` - Redis client factory using ioredis
  - `RedisSessionStore` - Redis-backed session storage
  - `RedisRateLimitStore` - Fixed-window rate limiting with Lua scripts
  - `RedisSlidingWindowRateLimitStore` - Sliding-window rate limiting
  - `RedisApiTokenStore` - API token storage with user indexing
  - `RedisPasswordResetStore` - Password reset token storage
  - `RedisEmailVerificationStore` - Email verification token storage

- **Queue/Job System**: Background job processing
  - `Job` - Base class with `dispatch()` and `dispatchAfter()` static methods
  - `Worker` - Queue worker with configurable options
  - `QueueManager` - Manager pattern for multiple queue drivers
  - `MemoryDriver` - In-memory queue driver for testing
  - `RedisDriver` - Redis-backed queue driver for production
  - Retry logic with exponential/linear/fixed backoff strategies
  - Failed job tracking and retry functionality

- **Mail Service**: Email sending abstraction
  - `Mail` - Fluent builder for composing emails
  - `MailManager` - Manager pattern for multiple transports
  - `SmtpTransport` - SMTP transport using Nodemailer
  - `ResendTransport` - Resend API transport
  - `MemoryTransport` - In-memory transport for testing with assertions
  - Queue integration for async email sending
  - React Email template support (optional)

- **Cache Layer**: Application caching abstraction
  - `CacheManager` - Manager pattern for multiple cache stores
  - `MemoryCacheStore` - In-memory cache with TTL support
  - `RedisCacheStore` - Redis-backed cache using ioredis
  - `FileCacheStore` - File-based cache with SHA256 hashed filenames
  - `TaggedCache` - Tag-based cache invalidation
  - `remember()` / `rememberForever()` - Callback caching pattern
  - `increment()` / `decrement()` - Atomic counter operations

- **File Storage**: Unified file storage abstraction
  - `StorageManager` - Manager pattern for multiple storage disks
  - `LocalStorageDriver` - Local filesystem storage
  - `MemoryStorageDriver` - In-memory storage for testing
  - `S3Driver` - AWS S3 storage with presigned URLs
  - File operations: `put`, `get`, `exists`, `delete`, `copy`, `move`
  - Directory operations: `files`, `directories`, `makeDirectory`, `deleteDirectory`
  - URL generation with `url()` and `temporaryUrl()`

- **Task Scheduling**: Cron-based task scheduler
  - `Scheduler` - Central scheduler with start/stop control
  - `Schedule` - Fluent builder for task definitions
  - `PendingSchedule` - Frequency helpers: `everyMinute()`, `hourly()`, `daily()`, `weekly()`, `monthly()`, etc.
  - `ScheduledTask` - Task wrapper with before/after callbacks
  - Cron expression parsing with `parseCron()`, `isDue()`, `getNextOccurrence()`
  - Timezone support and overlap prevention
  - Day-of-week helpers: `mondays()`, `weekdays()`, `weekends()`

- **Logging**: Structured logging abstraction
  - `LogManager` - Manager pattern for multiple log channels
  - `Logger` - Log methods: `emergency()`, `alert()`, `critical()`, `error()`, `warning()`, `notice()`, `info()`, `debug()`
  - `ConsoleChannel` - Console output with colors and timestamps
  - `FileChannel` - Single file logging
  - `DailyFileChannel` - Daily rotating file logs with cleanup
  - Stack channels for logging to multiple outputs
  - Context inheritance with `withContext()` / `child()`

#### @guren/cli

- **queue:work**: Start a queue worker to process jobs
  - `--queue` - Specify queue names (comma-separated)
  - `--once` - Process single job and exit
  - `--sleep` - Sleep time between polls
  - `--timeout` - Job timeout in seconds
  - `--max-jobs` - Maximum jobs to process

- **queue:failed**: List all failed queue jobs
- **queue:retry**: Retry failed jobs (single or all)
- **queue:flush**: Delete all failed jobs

- **db:rollback**: Rollback database migrations
  - `--step` - Number of migrations to rollback
  - `--batch` - Rollback entire last batch
  - `--force` - Skip confirmation in production
  - Requires `.down.sql` files for each migration

- **db:status**: Show migration status with visual indicators

- **db:reset**: Drop all tables and re-run migrations
  - `--seed` flag to run seeders after reset
  - `--force` required in production environment

- **db:fresh**: Alias for `db:reset`

- **make:job**: Generate a new job class with payload interface
- **make:event**: Generate a new event class
- **make:listener**: Generate a new event listener
  - `--event` - Specify event class to listen for
- **make:mail**: Generate a new mailable class
- **make:middleware**: Generate a new middleware function
- **make:seeder**: Generate a new database seeder
- **make:notification**: Generate a new notification class

### Changed

- Route methods (`get`, `post`, `put`, `patch`, `delete`) now return `RouteBuilder` for chaining
- `Route.clear()` now also clears named routes

### Documentation

- Added JSDoc comments to `Route.ts` with examples for all public methods
- Added JSDoc comments to `Model.ts` with examples for all query methods
- New guide: CSRF Protection (English and Japanese)
- New guide: Validation (English and Japanese)
- New guide: Error Handling (English and Japanese)

### Testing

- Added comprehensive tests for CSRF middleware (17 tests)
- Added comprehensive tests for validation middleware (12 tests)
- Added tests for named routes and resource routes (15 tests)
- Added tests for password reset functionality (22 tests)
- Added tests for email verification functionality (39 tests)
- Added tests for rate limiting middleware (29 tests)
- Added tests for API token authentication (41 tests)
- Added CLI tests for `make:controller` (11 tests)
- Added CLI tests for `make:model` (12 tests)
- Added CLI tests for `routes:types` (15 tests)
- Added CLI tests for `db:reset` (7 tests)
- Added CLI tests for migration tracker (17 tests)
- Added session middleware tests (17 tests)
- Added auth middleware tests (13 tests)
- Added DrizzleAdapter tests (24 tests)
- Added Model pagination tests (8 tests)
- Added Seeder tests (12 tests)
- Added Event System tests (37 tests)
- Added Queue/Job System tests (42 tests)
- Added Mail Service tests (29 tests)
- Added Redis Stores tests (34 tests, requires REDIS_URL)
- Added Cache Layer tests (48 tests)
- Added File Storage tests (52 tests)
- Added Task Scheduling tests (49 tests)
- Added Logging tests (36 tests)
- Added CLI make:* command tests (19 tests)

#### @guren/testing

- Added controller testing utilities self-tests (28 tests)
- Improved `parseRequestPayload` mock to support JSON, form-urlencoded, and multipart content types
- Fixed `redirect` method to use correct HTTP status codes (303 for POST/PUT/PATCH)
- Added `status` option support to `inertia` mock method

#### examples/blog

- Added comprehensive authentication E2E tests (16 tests)
- Added Inertia response format E2E tests (14 tests)

## [0.1.0] - 2024-XX-XX

### Added

- Initial release of Guren framework
- `@guren/server` - HTTP server with Hono integration
- `@guren/orm` - ActiveRecord-style ORM with Drizzle adapter
- `@guren/cli` - Command-line scaffolding tools
- `@guren/core` - Shared utilities
- `@guren/create-app` - Project scaffolding
- `@guren/inertia-client` - Inertia.js client integration
- `@guren/testing` - Testing utilities

[Unreleased]: https://github.com/user/guren/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/user/guren/releases/tag/v0.1.0
