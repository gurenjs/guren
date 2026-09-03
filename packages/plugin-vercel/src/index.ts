import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'
import { definePlugin, type ServiceProviderConstructor } from '@guren/core'
import {
  appUsesMcpPlugin,
  assertOutputDirOutsideRoot,
  clientManifestJson,
  DEV_ONLY_MODULES,
  DOCUMENT_ASSET_EXTENSIONS,
  DOCUMENT_ASSET_HEADERS,
  MCP_SDK_SUBPATH_PREFIX,
  removeShadowingIndex,
  renderDevOnlyStub,
  stubbableDevOnlyModules,
  resetOutputDir,
  resolveClientAssetEnv,
  resolvePathLike,
  resolveSsrEntryFile,
  ssrRuntimePaths,
  unusedSqlClients,
  type DatabaseDialect,
  type PathLike,
} from '@guren/core/internal/deploy-build'

/** Prefixes every diagnostic this build emits. */
const LABEL = 'Vercel build'

export interface VercelAppLike {
  boot(): Promise<void>
  fetch(request: Request): Response | Promise<Response>
}

export interface VercelHandler {
  fetch(request: Request): Response | Promise<Response>
}

export interface BuildVercelOutputOptions {
  rootDir?: PathLike
  entrypoint?: PathLike
  outputDir?: PathLike
  publicDir?: PathLike
  docsDir?: PathLike
  ssrDir?: PathLike
  migrationsDir?: PathLike
  /**
   * Databases this app connects to, overriding what is read from
   * `config/database.ts`. Every other dialect's client is stubbed out of the
   * bundle. Pass this when the config reaches a factory without naming it and
   * the build reports that it could not tell.
   */
  databaseDialects?: readonly DatabaseDialect[]
}

/**
 * Configuration for the Vercel plugin. Currently empty — reserved so future
 * fields never force another registration-shape change.
 */
export interface VercelPluginConfig {}

const factory = definePlugin<VercelPluginConfig>({
  name: 'vercel',
  register() {},
})

/**
 * Register the Vercel plugin.
 *
 * @example
 * ```typescript
 * createApp({ providers: [vercelPlugin()] })
 * ```
 */
export function vercelPlugin(config: VercelPluginConfig = {}): ServiceProviderConstructor {
  return factory(config)
}

export async function createVercelHandler(app: VercelAppLike): Promise<VercelHandler> {
  await app.boot()
  return {
    fetch(request: Request) {
      return app.fetch(request)
    },
  }
}

export async function buildVercelOutput(options: BuildVercelOutputOptions = {}): Promise<void> {
  const root = resolvePathLike(options.rootDir ?? new URL('..', import.meta.url))
  const out = resolvePathLike(options.outputDir ?? resolve(root, '.vercel/output'))
  const funcDir = resolve(out, 'functions/index.func')
  const entrypoint = resolvePathLike(options.entrypoint ?? resolve(root, 'src/vercel.ts'))
  const handler = `${basename(entrypoint, extname(entrypoint))}.js`
  const publicDir = resolvePathLike(options.publicDir ?? resolve(root, 'public'))
  const docsDir = resolvePathLike(options.docsDir ?? resolveNearestDocsDir(root) ?? resolve(root, 'docs'))
  const ssrDir = resolvePathLike(options.ssrDir ?? resolve(root, '.guren/ssr'))
  const migrationsDir = resolvePathLike(options.migrationsDir ?? resolve(root, 'db/migrations'))

  // Validated up front so a bad option fails before anything else, but the
  // delete waits until the environment resolves — a stale or partial SSR build
  // must not take the previous deploy output with it.
  assertOutputDirOutsideRoot(out, root, LABEL)

  // Checked here rather than left to the spawned `bun build`, which only
  // fails after the previous output is gone.
  if (!existsSync(entrypoint)) {
    throw new Error(
      `${LABEL}: entrypoint not found at ${entrypoint}. Run \`bunx guren plugin @guren/plugin-vercel\` to scaffold src/vercel.ts, or pass "entrypoint".`,
    )
  }

  const env = buildVercelEnvironment(publicDir, ssrDir)

  resetOutputDir(out, root, LABEL)

  mkdirSync(funcDir, { recursive: true })
  mkdirSync(resolve(out, 'static'), { recursive: true })

  writeFileSync(
    resolve(out, 'config.json'),
    JSON.stringify(
      {
        version: 3,
        routes: [
          // Built assets self-reference the Vite plugin's derived base,
          // `/public/assets/`, while the files themselves are copied to the
          // output root. Without this the entry script still loads — its path
          // is injected directly — but every chunk it imports falls through
          // to the function and comes back as HTML.
          //
          // A `rewrites` entry in vercel.json only covers builds Vercel runs
          // itself; a `--prebuilt` upload is routed by this file alone, which
          // is the flow the deployment guide documents.
          { src: '/public/(.*)', dest: '/$1' },
          { handle: 'filesystem' },
          { src: '/(.*)', dest: '/index' },
          // Everything below runs only once a build match was found, and is
          // matched against the *resolved* destination rather than the
          // requested path (vercel's dev router passes getReqUrl(routeResult),
          // i.e. routeResult.dest). Both halves matter: a request the CDN
          // answered keeps its own path and matches, while one that fell
          // through the rule above arrives here as "/index" and cannot. In the
          // initial phase the same pattern would match either, so a dynamic
          // /sitemap.xml would come back as a download.
          { handle: 'hit' },
          {
            src: documentAssetPattern(),
            headers: { ...DOCUMENT_ASSET_HEADERS },
            // Required of every route after `handle: 'hit'`, which also
            // forbids `dest` and `status` — the phase exists to decorate a
            // response, not to route one. A header the function already set is
            // left alone in this phase, so a route serving its own
            // Content-Disposition keeps it.
            continue: true,
          },
        ],
      },
      null,
      2,
    ),
  )

  writeFileSync(
    resolve(funcDir, '.vc-config.json'),
    JSON.stringify(
      {
        handler,
        runtime: 'bun1.x',
        launcherType: 'Nodejs',
        shouldAddHelpers: true,
        environment: env,
      },
      null,
      2,
    ),
  )

  await bundleFunction({
    entrypoint,
    funcDir,
    root,
    dialects: options.databaseDialects,
    // Inlined into the bundle rather than added to the function environment:
    // Vercel caps environment configuration size, which a real app's manifest
    // can exceed, and the bundle has no such limit.
    viteManifest: clientManifestJson(publicDir),
  })

  if (existsSync(ssrDir)) {
    cpSync(ssrDir, resolve(funcDir, '.guren/ssr'), { recursive: true })
  }

  if (existsSync(migrationsDir)) {
    cpSync(migrationsDir, resolve(funcDir, 'db/migrations'), { recursive: true })
  }

  if (existsSync(docsDir)) {
    cpSync(docsDir, resolve(funcDir, 'docs'), { recursive: true })
  }

  if (existsSync(publicDir)) {
    // No `/public/assets` mirror here, unlike `stageStaticAssets`: the
    // generated `config.json` rewrites `/public/(.*)` onto the output root
    // instead. The dev shell still has to go — the CDN answers for `static/`
    // ahead of the function, so `index.html` would shadow the app's root route.
    cpSync(publicDir, resolve(out, 'static'), { recursive: true })
    removeShadowingIndex(resolve(out, 'static'))
  }
}

/**
 * Matches a staged path whose extension a browser would render as a document.
 *
 * The CDN serves `.vercel/output/static` ahead of the function, so the
 * framework's own guard never sees these files. This is the same policy
 * expressed in the one place that still reaches them.
 *
 * Spelled with a character class per letter because Vercel compiles `src`
 * case-sensitively: a plain extension would leave logo.SVG inline, while the
 * framework guard lowercases before its mime lookup and catches it. An inline
 * case-insensitive flag is not an option, because `src` is validated by
 * constructing a JavaScript `RegExp` from it.
 */
function documentAssetPattern(): string {
  const alternatives = DOCUMENT_ASSET_EXTENSIONS.map((extension) =>
    [...extension].map((character) => `[${character}${character.toUpperCase()}]`).join(''),
  ).join('|')

  return `^/.*\\.(?:${alternatives})$`
}

const MCP_UNAVAILABLE =
  'The MCP endpoint is unavailable on Vercel — it generates files on disk, and the function filesystem is read-only.'

/**
 * Why each dev-only module cannot run here, or `null` for one that can and is
 * therefore left alone.
 *
 * `sqlite` is the `null`, and it is written as an entry rather than filtered
 * out somewhere else so the decision sits where the reason does: the function
 * runs on Vercel's Bun runtime, so `bun:sqlite` is a working database here —
 * unlike on Workers and Lambda, whose tables name a replacement for it.
 * Stubbing it would break an app that ships a read-only sqlite file beside
 * its function.
 *
 * Keyed on every kind `DEV_ONLY_MODULES` contains, so a kind added there is a
 * compile error here rather than a module that silently stubs to `undefined`.
 */
const UNAVAILABLE_ON_VERCEL: Record<(typeof DEV_ONLY_MODULES)[number]['kind'], string | null> = {
  sqlite: null,
  vite: 'The Vite dev server is unavailable on Vercel — assets are served from the static output directory.',
  mcp: MCP_UNAVAILABLE,
}

/**
 * Modules replaced with throwing stubs, in the order they are matched.
 *
 * Two separate reasons, both of them the same defect shape — a *literal*
 * dynamic import of a package the app never installed, which a bundler
 * follows whether or not the branch can be taken:
 *
 * - The dev-only ones. A scaffolded app could not be bundled for Vercel at
 *   all: the disabled MCP endpoint's `import("@guren/cli")` resolves, and the
 *   CLI's own `import("@guren/openapi")` behind it does not. Lambda never saw
 *   this because it has stubbed these since it shipped.
 * - The database clients for dialects the app does not use, decided per app
 *   rather than per platform — the ones it *does* use are load-bearing here,
 *   unlike on Workers where D1 is the only database.
 *
 * The dev-only set is per app in one respect too: an app declaring
 * `@guren/plugin-mcp` serves the App MCP endpoint from this function, so its
 * transport must reach the bundle (RFC 0016 §7). The *Dev* MCP's `McpServer`
 * and the CLI behind it stay stubbed regardless — see
 * `stubbableDevOnlyModules`.
 */
function stubbedModules(
  root: string,
  dialects: readonly DatabaseDialect[] | undefined,
  mcpPlugin: boolean,
): Record<string, string> {
  const devOnly = stubbableDevOnlyModules({ mcpPlugin }).flatMap((module) => {
    const message = UNAVAILABLE_ON_VERCEL[module.kind]
    return message === null ? [] : [[module.specifier, renderDevOnlyStub(module, message)]]
  })

  const unused = unusedSqlClients({ root, label: LABEL, dialects }).map(({ module, message }) => [
    module.specifier,
    renderDevOnlyStub(module, message),
  ])

  return Object.fromEntries([...devOnly, ...unused])
}

/**
 * Fallback for an MCP SDK subpath `DEV_ONLY_MODULES` does not name. It cannot
 * know which names the importer destructures, so it throws on evaluation
 * rather than resolving to an empty module: a subpath reached from app code
 * (not Guren's disabled MCP endpoint) must fail loudly at build or cold start,
 * never silently hand back missing exports.
 *
 * Reachable only for an app that does *not* declare `@guren/plugin-mcp`. For
 * one that does, the SDK is a dependency it deliberately ships, and this
 * fallback would stub `server/index.js` and `types.js` — which
 * `@guren/plugin-mcp` imports statically — leaving the endpoint just as
 * compiled shut as the transport stub did.
 */
const unlistedMcpStub = `throw new Error(${JSON.stringify(MCP_UNAVAILABLE)})\n`

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Derived from the stubs actually rendered so it stays the only enumeration
// of stubbed specifiers — a hand-maintained regex could silently fall out of
// sync, and a specifier that is filtered but has no stub would load as an
// empty module instead of failing.
//
// The catch-all is the one term that cannot be derived from the stubs, and
// the tempting derivation is actively wrong: "include it while any MCP SDK
// subpath is still stubbed" holds always, because
// `@modelcontextprotocol/sdk/server/mcp.js` stays stubbed for every app —
// so the catch-all would keep swallowing `server/index.js` and `types.js`
// and undo RFC 0016 Phase 4a silently. So it is gated on the same `mcpPlugin`
// decision that produced the stubs, threaded from one read of the app's
// manifest rather than re-derived here.
function stubFilter(stubs: Record<string, string>, mcpPlugin: boolean): RegExp {
  const terms = Object.keys(stubs).map(escapeRegExp)
  if (!mcpPlugin) {
    terms.push(`${escapeRegExp(MCP_SDK_SUBPATH_PREFIX)}.+`)
  }

  return new RegExp(`^(?:${terms.join('|')})$`)
}

/**
 * Bundle the function with Bun's JS API rather than by spawning `bun build`.
 *
 * The CLI has no way to replace a module — no alias flag, no plugin flag — and
 * this build needs one, which is why this platform had no stub mechanism at
 * all while the other two did. The API takes plugins.
 */
async function bundleFunction(input: {
  entrypoint: string
  funcDir: string
  root: string
  dialects: readonly DatabaseDialect[] | undefined
  viteManifest: string | undefined
}): Promise<void> {
  // One read of the app's manifest, threaded to both halves of the stub
  // decision: which modules are rendered, and whether unlisted MCP SDK
  // subpaths are swallowed by the catch-all. Two independent reads would be
  // two places for them to disagree, silently.
  const mcpPlugin = appUsesMcpPlugin(input.root)
  const stubs = stubbedModules(input.root, input.dialects, mcpPlugin)
  const filter = stubFilter(stubs, mcpPlugin)

  const result = await Bun.build({
    entrypoints: [input.entrypoint],
    // `Bun.build` rejects with a bare "Bundle failed" AggregateError by
    // default (Bun >= 1.2), which discards the one line that matters — the
    // module it could not resolve. Opting out of that is what makes the
    // `result.logs` report below reachable at all.
    throw: false,
    outdir: input.funcDir,
    target: 'bun',
    // Whitespace and syntax only — never plain `minify: true`, which also
    // mangles identifiers. Guren keys durable records on class names: the
    // queue registry stores each job's wire name (its class name unless it
    // declares a jobName) in every queued message, and notifications persist
    // `constructor.name` as their `type`. Mangled, a job dispatched by one
    // deploy resolves to nothing after the next.
    //
    // Not `keepNames`: as of Bun 1.3.14 it is accepted and silently leaves
    // class names mangled, so it cannot replace this.
    minify: { whitespace: true, syntax: true, identifiers: false },
    define: {
      // `bun build` inlines `process.env.NODE_ENV` at bundle time (defaulting
      // to "development"), so pin it to "production" for the deployed function.
      'process.env.NODE_ENV': '"production"',
      // viteAsset() resolves content-page assets from the client manifest at
      // render time; substitute the read with the manifest JSON so the
      // function needs neither the file nor environment configuration. A
      // `define` matches one exact expression — @guren/server pins the read's
      // form at the source level (tests/env-gate-form.test.ts) so this cannot
      // silently stop matching.
      ...(input.viteManifest
        ? { 'process.env.GUREN_VITE_MANIFEST': JSON.stringify(input.viteManifest) }
        : {}),
    },
    plugins: [
      {
        name: 'guren-vercel-stubs',
        setup(build) {
          build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'guren-vercel-stub' }))
          build.onLoad({ filter: /.*/, namespace: 'guren-vercel-stub' }, (args) => ({
            contents: stubs[args.path] ?? unlistedMcpStub,
            loader: 'js',
          }))
        },
      },
    ],
  })

  if (!result.success) {
    throw new Error(`${LABEL}: bun build failed.\n${result.logs.map((log) => String(log)).join('\n')}`)
  }
}

function buildVercelEnvironment(publicDir: string, ssrDir: string): Record<string, string> {
  const env: Record<string, string> = {
    NODE_ENV: 'production',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: '/tmp/.bun-cache',
    BUN_INSTALL_CACHE_DIR: '/tmp/.bun-install-cache',
    TMPDIR: '/tmp',
  }

  const assetEnv = resolveClientAssetEnv(publicDir, 'resources/js/app.tsx', LABEL)
  if (assetEnv.entry) {
    env.GUREN_INERTIA_ENTRY = assetEnv.entry
  }
  if (assetEnv.styles) {
    env.GUREN_INERTIA_STYLES = assetEnv.styles
  }

  const ssrFile = resolveSsrEntryFile(ssrDir, 'resources/js/ssr.tsx', LABEL)
  if (ssrFile) {
    // Relative specifiers resolve from the function root, where the SSR bundle
    // is copied.
    const ssrPaths = ssrRuntimePaths(ssrDir, ssrFile, './.guren/ssr')
    env.GUREN_INERTIA_SSR_ENTRY = ssrPaths.entry
    if (ssrPaths.manifest) {
      env.GUREN_INERTIA_SSR_MANIFEST = ssrPaths.manifest
    }
  }

  env.GUREN_INERTIA_IMPORT_MAP = JSON.stringify({
    '@guren/inertia-client': '/vendor/inertia-client.tsx',
  })

  return env
}

function resolveNearestDocsDir(startDir: string, maxDepth = 6): string | undefined {
  let currentDir = startDir

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const candidate = resolve(currentDir, 'docs')
    if (existsSync(candidate)) {
      return candidate
    }

    const parent = resolve(currentDir, '..')
    if (parent === currentDir) {
      break
    }
    currentDir = parent
  }

  return undefined
}

