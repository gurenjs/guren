import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function read(root: string, relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), 'utf8')
}

async function auditEnglishDocs(root: string): Promise<void> {
  const readme = await read(root, 'README.md')
  assert(readme.includes('bunx guren add auth'), 'README must document the standard auth scaffold path.')
  assert(readme.includes('bunx guren add notifications'), 'README must document the standard notifications scaffold path.')
  assert(readme.includes('bunx guren add storage'), 'README must document the standard storage scaffold path.')
  assert(readme.includes('bunx guren add broadcasting'), 'README must document the standard broadcasting scaffold path.')
  assert(readme.includes('bun run codegen'), 'README must document codegen in the standard flow.')
  assert(readme.includes('bun run build'), 'README must document canonical production builds via bun run build.')

  const firstSteps = await read(root, 'docs/en/guides/first-steps.md')
  assert(firstSteps.includes('@guren/core'), 'First Steps must describe the @guren/core standard path.')
  assert(firstSteps.includes('new PostResource(post).toJSON()'), 'First Steps must show explicit resource serialization.')
  assert(firstSteps.includes('pages.posts.Index'), 'First Steps must use typed page definitions.')
  assert(firstSteps.includes('validateQuery'), 'First Steps must show schema-based request validation.')

  const cli = await read(root, 'docs/en/guides/cli.md')
  assert(cli.includes('bunx guren add notifications'), 'CLI guide must document the notifications scaffold path.')
  assert(cli.includes('bunx guren add storage'), 'CLI guide must document the storage scaffold path.')
  assert(cli.includes('bunx guren add broadcasting'), 'CLI guide must document the broadcasting scaffold path.')
  assert(cli.includes('bunx guren spec:generate'), 'CLI guide must document the spec view generator.')
  assert(cli.includes('bunx guren check --docs'), 'CLI guide must document the doc-link CI gate.')
  assert(cli.includes('bunx guren check --spec'), 'CLI guide must document the spec drift CI gate.')
  assert(!cli.includes('`check` and `audit` both exit'), 'CLI guide must not claim plain check sets an exit code — only the suite flags gate CI.')
  assert(cli.includes('`make:command <Name>`'), 'CLI guide must list make:command in the scaffold table.')
  assert(cli.includes('bun run console <command>'), 'CLI guide must distinguish the app command runner from the `guren console` REPL.')

  const consoleGuide = await read(root, 'docs/en/guides/console.md')
  assert(consoleGuide.includes('bunx guren make:command'), 'Console guide must document the make:command scaffold.')
  assert(consoleGuide.includes("import { ConsoleKernel } from '@guren/core'"), 'Console guide must build the kernel from @guren/core.')
  assert(consoleGuide.includes('export const kernel ='), 'Console guide must name the kernel export `kernel`, matching what the serverless recipes import.')
  assert(consoleGuide.includes('kernel.register'), 'Console guide must show that generated commands are registered explicitly.')
  assert(consoleGuide.includes('kernel.handle('), 'Console guide must show how argv reaches the kernel.')
  assert(!consoleGuide.includes("from '../modules/billing/app/"), 'Console guide must register module commands through the module index — a deep import fails `guren check --arch`.')

  const specAnchored = await read(root, 'docs/en/guides/spec-anchored.md')
  assert(specAnchored.includes('Derived where possible, declared where not, checked always'), 'Spec-anchored guide must state the principle.')
  assert(specAnchored.includes('bunx guren spec:generate'), 'Spec-anchored guide must document spec:generate.')
  assert(specAnchored.includes('bunx guren context User'), 'Spec-anchored guide must document entity context.')
  assert(specAnchored.includes('bunx guren make:adr'), 'Spec-anchored guide must document make:adr.')
  assert(specAnchored.includes('bunx guren check --docs'), 'Spec-anchored guide must document the doc-link gate.')

  const overview = await read(root, 'docs/en/guides/overview.md')
  assert(overview.includes("import { Controller, paginate, type PaginatedPageProps } from '@guren/core'"), 'Overview must show the canonical controller import path.')
  assert(overview.includes('await this.validateBody(CreateTaskSchema)'), 'Overview must show validateBody() in the controller example.')
  assert(overview.includes('pages.tasks.Index'), 'Overview must show typed page definitions instead of string page names.')
  assert(!overview.includes("this.inertia('Tasks/Index'"), 'Overview must not use string-based page names in the controller example.')
  assert(!overview.includes('await this.only('), 'Overview must not use legacy this.only() input handling.')

  const routing = await read(root, 'docs/en/guides/routing.md')
  assert(routing.includes("import { Router } from '@guren/core'"), 'Routing guide must use Router from @guren/core.')
  assert(routing.includes('createApp({'), 'Routing guide must show createApp() bootstrap.')
  assert(routing.includes('pages.posts.Show'), 'Routing guide must use typed page definitions in model binding examples.')

  const controllers = await read(root, 'docs/en/guides/controllers.md')
  assert(controllers.includes('PaginatedPageProps<PostResourceData>'), 'Controllers guide must show paginated page props in the canonical path.')
  assert(controllers.includes('pages.posts.Index'), 'Controllers guide must use typed page definitions instead of string page names.')
  assert(!controllers.includes('await this.only('), 'Controllers guide must not use legacy this.only() examples.')
  assert(!controllers.includes("this.inertia('posts/Index'"), 'Controllers guide must not use string-based Inertia page names in canonical examples.')

  const middleware = await read(root, 'docs/en/guides/middleware.md')
  assert(middleware.includes("import { Router } from '@guren/core'"), 'Middleware guide must use Router from @guren/core.')
  assert(middleware.includes('router.aliasMiddleware('), 'Middleware guide must use router.aliasMiddleware().')
  assert(!middleware.includes('Route.aliasMiddleware('), 'Middleware guide must not use legacy Route.aliasMiddleware().')

  const validation = await read(root, 'docs/en/guides/validation.md')
  assert(validation.includes('this.validateBody(StorePostSchema)'), 'Validation guide must show validateBody() in the mainline example.')
  assert(validation.includes('pages.posts.Index'), 'Validation guide must show typed page definitions in the mainline example.')
  assert(validation.includes("const router = new Router()"), 'Validation guide must use Router for middleware-based validation examples.')

  const database = await read(root, 'docs/en/guides/database.md')
  assert(database.includes('PaginatedPageProps<PostResourceData>'), 'Database guide must show paginated resource contracts.')
  assert(database.includes('pages.posts.Index'), 'Database guide must use typed page definitions in pagination examples.')

  const architecture = await read(root, 'docs/en/guides/architecture.md')
  assert(architecture.includes('PaginatedPageProps<PostResourceData>'), 'Architecture guide must show paginated page props in controller examples.')
  assert(architecture.includes('pages.posts.Index'), 'Architecture guide must use typed page definitions in controller examples.')

  const rateLimiting = await read(root, 'docs/en/guides/rate-limiting.md')
  assert(rateLimiting.includes("import { Router, createRateLimitMiddleware } from '@guren/core'"), 'Rate limiting guide must use Router from @guren/core.')
  assert(!rateLimiting.includes('Route.post('), 'Rate limiting guide must not use legacy Route.post() examples.')

  const relationships = await read(root, 'docs/en/tutorials/relationships.md')
  assert(relationships.includes('pages.posts.Show'), 'Relationships tutorial must use typed page definitions.')
  assert(relationships.includes("hasMany('comments'"), 'Relationships tutorial must declare the hasMany relation.')
  assert(relationships.includes(".with('author')"), 'Relationships tutorial must demonstrate eager loading.')

  const frontend = await read(root, 'docs/en/guides/frontend.md')
  assert(frontend.includes('interface Props'), 'Frontend guide must show Props interface pattern.')
  assert(frontend.includes('bun run build'), 'Frontend guide must document the canonical build command.')
  assert(!frontend.includes("this.inertia('posts/Index'"), 'Frontend guide must not use string-based page names in the mainline example.')

  const blogTutorial = await read(root, 'docs/en/tutorials/create-blog-post-app.md')
  assert(blogTutorial.includes('PaginatedPageProps<'), 'Blog tutorial must show the paginated page-props contract.')
  assert(blogTutorial.includes('pages.posts.Index'), 'Blog tutorial must use typed page definitions in the controller example.')
  assert(blogTutorial.includes('validateBody'), 'Blog tutorial must show schema-based body validation.')

  const authentication = await read(root, 'docs/en/guides/authentication.md')
  assert(authentication.includes('pages.dashboard.Index'), 'Authentication guide must use typed page definitions for dashboard pages.')

  const authorization = await read(root, 'docs/en/guides/authorization.md')
  assert(authorization.includes('pages.posts.Show'), 'Authorization guide must use resource output in Inertia examples.')
  assert(!authorization.includes('Route.get('), 'Authorization guide must not use legacy Route.get() route examples.')

  const emailVerification = await read(root, 'docs/en/guides/email-verification.md')
  assert(emailVerification.includes("import { Router } from '@guren/core'"), 'Email verification guide must use Router from @guren/core.')
  assert(emailVerification.includes('pages.auth.VerifyEmail'), 'Email verification guide must use typed page definitions.')

  const passwordReset = await read(root, 'docs/en/guides/password-reset.md')
  assert(passwordReset.includes('this.validateBody(ForgotPasswordSchema)'), 'Password reset guide must use validateBody() for request parsing.')
  assert(passwordReset.includes('pages.auth.ResetPassword'), 'Password reset guide must use typed page definitions.')

  const apiTokens = await read(root, 'docs/en/guides/api-tokens.md')
  assert(apiTokens.includes("import { Router } from '@guren/core'"), 'API tokens guide must use Router from @guren/core.')
  assert(!apiTokens.includes('Route.get('), 'API tokens guide must not use legacy Route.get() examples.')

  const broadcasting = await read(root, 'docs/en/guides/broadcasting.md')
  assert(broadcasting.includes("import { Router } from '@guren/core'"), 'Broadcasting guide must use Router from @guren/core.')
  assert(!broadcasting.includes('Route.get('), 'Broadcasting guide must not use legacy Route.get() examples.')

  const errorHandling = await read(root, 'docs/en/guides/error-handling.md')
  assert(errorHandling.includes('pages.posts.Show'), 'Error handling guide must use typed page definitions in Inertia examples.')

  const deployment = await read(root, 'docs/en/guides/deployment.md')
  assert(deployment.includes("router.get('/health'"), 'Deployment guide must use router-based health checks.')

  const csrf = await read(root, 'docs/en/guides/csrf.md')
  assert(csrf.includes('pages.forms.Create'), 'CSRF guide must use typed page definitions in controller examples.')
  assert(!csrf.includes('Route.post('), 'CSRF guide must not use legacy Route.post() examples.')

  // Task-completion guides
  const buildAuthApp = await read(root, 'docs/en/guides/build-auth-app.md')
  assert(buildAuthApp.includes('bunx create-guren-app'), 'Build auth app guide must include project scaffolding.')
  assert(buildAuthApp.includes('bunx guren add auth'), 'Build auth app guide must include auth scaffold command.')
  assert(buildAuthApp.includes('bun run codegen'), 'Build auth app guide must include codegen step.')

  const shipApi = await read(root, 'docs/en/guides/ship-api.md')
  assert(shipApi.includes('--blueprint api'), 'Ship API guide must reference the api blueprint.')
  assert(shipApi.includes('bun run codegen'), 'Ship API guide must include codegen step.')

  const deployProduction = await read(root, 'docs/en/guides/deploy-production.md')
  assert(deployProduction.includes('bun run build'), 'Deploy guide must include the build command.')
  assert(deployProduction.includes('bun run typecheck'), 'Deploy guide must include typecheck in pre-deploy.')
  assert(deployProduction.includes('/health'), 'Deploy guide must reference health check endpoint.')

  const troubleshoot = await read(root, 'docs/en/guides/troubleshoot.md')
  assert(troubleshoot.includes('bunx guren doctor'), 'Troubleshoot guide must reference the doctor command.')
  assert(troubleshoot.includes('bun run codegen'), 'Troubleshoot guide must include codegen as a fix.')

}

async function auditJapaneseDocs(root: string): Promise<void> {
  const firstSteps = await read(root, 'docs/ja/guides/first-steps.md')
  assert(firstSteps.includes('@guren/core'), 'Japanese First Steps must describe the @guren/core standard path.')
  assert(firstSteps.includes('new PostResource(post).toJSON()'), 'Japanese First Steps must show explicit resource serialization.')
  assert(firstSteps.includes('pages.posts.Index'), 'Japanese First Steps must use typed page definitions.')
  assert(firstSteps.includes('validateQuery'), 'Japanese First Steps must show schema-based request validation.')

  const overview = await read(root, 'docs/ja/guides/overview.md')
  assert(overview.includes("import { Controller, paginate, type PaginatedPageProps } from '@guren/core'"), 'Japanese overview must show the canonical controller import path.')
  assert(overview.includes('await this.validateBody(CreateTaskSchema)'), 'Japanese overview must show validateBody() in the controller example.')
  assert(overview.includes('pages.tasks.Index'), 'Japanese overview must show typed page definitions instead of string page names.')
  assert(!overview.includes("this.inertia('Tasks/Index'"), 'Japanese overview must not use string-based page names in the controller example.')
  assert(!overview.includes('await this.only('), 'Japanese overview must not use legacy this.only() input handling.')

  const consoleGuide = await read(root, 'docs/ja/guides/console.md')
  assert(consoleGuide.includes('bunx guren make:command'), 'Japanese console guide must document the make:command scaffold.')
  assert(consoleGuide.includes("import { ConsoleKernel } from '@guren/core'"), 'Japanese console guide must build the kernel from @guren/core.')
  assert(consoleGuide.includes('export const kernel ='), 'Japanese console guide must name the kernel export `kernel`, matching what the serverless recipes import.')
  assert(consoleGuide.includes('kernel.register'), 'Japanese console guide must show that generated commands are registered explicitly.')
  assert(consoleGuide.includes('kernel.handle('), 'Japanese console guide must show how argv reaches the kernel.')
  assert(!consoleGuide.includes("from '../modules/billing/app/"), 'Japanese console guide must register module commands through the module index — a deep import fails `guren check --arch`.')

  const routing = await read(root, 'docs/ja/guides/routing.md')
  assert(routing.includes("import { Router } from '@guren/core'"), 'Japanese routing guide must use Router from @guren/core.')
  assert(routing.includes('createApp({'), 'Japanese routing guide must show createApp() bootstrap.')
  assert(!routing.includes('Route.aliasMiddleware('), 'Japanese routing guide must not use legacy Route.* middleware examples.')
  assert(routing.includes('pages.posts.Show'), 'Japanese routing guide must use typed page definitions in model binding examples.')

  const controllers = await read(root, 'docs/ja/guides/controllers.md')
  assert(controllers.includes('PaginatedPageProps<PostResourceData>'), 'Japanese controllers guide must show paginated page props in the canonical path.')
  assert(controllers.includes('pages.posts.Index'), 'Japanese controllers guide must use typed page definitions instead of string page names.')
  assert(!controllers.includes('await this.only('), 'Japanese controllers guide must not use legacy this.only() examples.')
  assert(!controllers.includes("this.inertia('posts/Index'"), 'Japanese controllers guide must not use string-based Inertia page names in canonical examples.')

  const middleware = await read(root, 'docs/ja/guides/middleware.md')
  assert(middleware.includes("import { Router } from '@guren/core'"), 'Japanese middleware guide must use Router from @guren/core.')
  assert(middleware.includes('router.get('), 'Japanese middleware guide must use router-based route middleware examples.')
  assert(!middleware.includes('Route.get('), 'Japanese middleware guide must not use legacy Route.get() examples.')

  const validation = await read(root, 'docs/ja/guides/validation.md')
  assert(validation.includes('this.validateBody(StorePostSchema)'), 'Japanese validation guide must show validateBody() in the mainline example.')
  assert(validation.includes('pages.posts.Index'), 'Japanese validation guide must show typed page definitions in the mainline example.')
  assert(validation.includes("const router = new Router()"), 'Japanese validation guide must use Router for middleware-based validation examples.')

  const database = await read(root, 'docs/ja/guides/database.md')
  assert(database.includes('PaginatedPageProps<PostResourceData>'), 'Japanese database guide must show paginated resource contracts.')
  assert(database.includes('pages.posts.Index'), 'Japanese database guide must use typed page definitions in pagination examples.')

  const architecture = await read(root, 'docs/ja/guides/architecture.md')
  assert(architecture.includes('PaginatedPageProps<PostResourceData>'), 'Japanese architecture guide must show paginated page props in controller examples.')
  assert(architecture.includes('pages.posts.Index'), 'Japanese architecture guide must use typed page definitions in controller examples.')

  const glossary = await read(root, 'docs/ja/guides/glossary.md')
  assert(glossary.includes('page definition'), 'Japanese glossary must describe typed page definitions for Inertia pages.')

  const rateLimiting = await read(root, 'docs/ja/guides/rate-limiting.md')
  assert(rateLimiting.includes("import { Router, createRateLimitMiddleware } from '@guren/core'"), 'Japanese rate limiting guide must use Router from @guren/core.')
  assert(!rateLimiting.includes('Route.post('), 'Japanese rate limiting guide must not use legacy Route.post() examples.')

  const relationships = await read(root, 'docs/ja/tutorials/relationships.md')
  assert(relationships.includes('pages.posts.Show'), 'Japanese relationships tutorial must use typed page definitions.')
  assert(relationships.includes("hasMany('comments'"), 'Japanese relationships tutorial must declare the hasMany relation.')
  assert(relationships.includes(".with('author')"), 'Japanese relationships tutorial must demonstrate eager loading.')

  const frontend = await read(root, 'docs/ja/guides/frontend.md')
  assert(frontend.includes('PageProps<typeof pages.posts.Index>'), 'Japanese frontend guide must show page-contract-based props.')
  assert(frontend.includes('bun run build'), 'Japanese frontend guide must document the canonical build command.')
  assert(!frontend.includes("this.inertia('posts/Index'"), 'Japanese frontend guide must not use string-based page names in the mainline example.')

  const blogTutorial = await read(root, 'docs/ja/tutorials/create-blog-post-app.md')
  assert(blogTutorial.includes('PaginatedPageProps<'), 'Japanese blog tutorial must show the paginated page-props contract.')
  assert(blogTutorial.includes('pages.posts.Index'), 'Japanese blog tutorial must use typed page definitions in the controller example.')
  assert(blogTutorial.includes('validateBody'), 'Japanese blog tutorial must show schema-based body validation.')

  const authentication = await read(root, 'docs/ja/guides/authentication.md')
  assert(authentication.includes('pages.dashboard.Index'), 'Japanese authentication guide must use typed page definitions for dashboard pages.')

  const authorization = await read(root, 'docs/ja/guides/authorization.md')
  assert(authorization.includes('pages.posts.Show'), 'Japanese authorization guide must use resource output in Inertia examples.')
  assert(!authorization.includes('Route.get('), 'Japanese authorization guide must not use legacy Route.get() route examples.')

  const emailVerification = await read(root, 'docs/ja/guides/email-verification.md')
  assert(emailVerification.includes("import { Router } from '@guren/core'"), 'Japanese email verification guide must use Router from @guren/core.')
  assert(emailVerification.includes('pages.auth.VerifyEmail'), 'Japanese email verification guide must use typed page definitions.')

  const passwordReset = await read(root, 'docs/ja/guides/password-reset.md')
  assert(passwordReset.includes('this.validateBody(ForgotPasswordSchema)'), 'Japanese password reset guide must use validateBody() for request parsing.')
  assert(passwordReset.includes('pages.auth.ResetPassword'), 'Japanese password reset guide must use typed page definitions.')

  const apiTokens = await read(root, 'docs/ja/guides/api-tokens.md')
  assert(apiTokens.includes("import { Router } from '@guren/core'"), 'Japanese API tokens guide must use Router from @guren/core.')
  assert(!apiTokens.includes('Route.get('), 'Japanese API tokens guide must not use legacy Route.get() examples.')

  const broadcasting = await read(root, 'docs/ja/guides/broadcasting.md')
  assert(broadcasting.includes("import { Router } from '@guren/core'"), 'Japanese broadcasting guide must use Router from @guren/core.')
  assert(!broadcasting.includes('Route.get('), 'Japanese broadcasting guide must not use legacy Route.get() examples.')

  const errorHandling = await read(root, 'docs/ja/guides/error-handling.md')
  assert(errorHandling.includes('pages.posts.Show'), 'Japanese error handling guide must use typed page definitions in Inertia examples.')

  const deployment = await read(root, 'docs/ja/guides/deployment.md')
  assert(deployment.includes("router.get('/health'"), 'Japanese deployment guide must use router-based health checks.')

  const csrf = await read(root, 'docs/ja/guides/csrf.md')
  assert(csrf.includes('pages.forms.Create'), 'Japanese CSRF guide must use typed page definitions in controller examples.')
  assert(!csrf.includes('Route.post('), 'Japanese CSRF guide must not use legacy Route.post() examples.')

  // Task-completion guides
  const jaBuildAuthApp = await read(root, 'docs/ja/guides/build-auth-app.md')
  assert(jaBuildAuthApp.includes('bunx create-guren-app'), 'Japanese build auth app guide must include project scaffolding.')
  assert(jaBuildAuthApp.includes('bunx guren add auth'), 'Japanese build auth app guide must include auth scaffold command.')

  const jaShipApi = await read(root, 'docs/ja/guides/ship-api.md')
  assert(jaShipApi.includes('--blueprint api'), 'Japanese ship API guide must reference the api blueprint.')

  const jaDeployProduction = await read(root, 'docs/ja/guides/deploy-production.md')
  assert(jaDeployProduction.includes('bun run build'), 'Japanese deploy guide must include the build command.')
  assert(jaDeployProduction.includes('/health'), 'Japanese deploy guide must reference health check endpoint.')

  const jaTroubleshoot = await read(root, 'docs/ja/guides/troubleshoot.md')
  assert(jaTroubleshoot.includes('bunx guren doctor'), 'Japanese troubleshoot guide must reference the doctor command.')

}

// The `@/` alias resolves from the project root; imports like `@/Http/...`
// are leftovers from the old `@/*` -> `./app/*` mapping and no longer resolve.
const STALE_APP_ALIAS_PATTERN = /['"]@\/(?:Http|Models|Policies|Events|Jobs|Listeners|Mail|Notifications|Providers|Services|Validators|Console|Exceptions|utils)\//u

async function auditAliasConvention(root: string): Promise<void> {
  const docsDir = join(root, 'docs')
  const entries = await readdir(docsDir, { recursive: true, withFileTypes: true })

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue
    }

    const filePath = join(entry.parentPath, entry.name)
    const lines = (await readFile(filePath, 'utf8')).split('\n')
    const hit = lines.findIndex((line) => STALE_APP_ALIAS_PATTERN.test(line))
    assert(
      hit === -1,
      `${relative(root, filePath)}:${hit + 1} uses an app-relative alias import (e.g. \`@/Http/...\`); the \`@/\` alias resolves from the project root, so write \`@/app/...\` instead.`,
    )
  }
}

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? '.')
  await auditEnglishDocs(root)
  await auditJapaneseDocs(root)
  await auditAliasConvention(root)
  console.log(`Docs audit passed for ${root}`)
}

await main()
