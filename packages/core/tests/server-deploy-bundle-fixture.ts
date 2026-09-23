/**
 * Subprocess fixture for `server-deploy-bundle.test.ts`: bundles the entry the
 * options file names with the deploy builds' minify options, every dev-only
 * module and SQL client stubbed, and prints what landed as JSON.
 */
import {
  BUN_DEPLOY_MINIFY,
  DEV_ONLY_MODULES,
  SQL_CLIENT_MODULES,
  renderDevOnlyStub,
} from '../src/internal/deploy-build'

export interface BundleOptions {
  entry: string
  define: Record<string, string>
}

export interface BundleReport {
  success: boolean
  logs: string[]
  inputs: string[]
  parseFont: boolean
}

const { entry, define } = (await Bun.file(process.argv[2]!).json()) as BundleOptions

const stubs: Record<string, string> = Object.fromEntries(
  [...DEV_ONLY_MODULES, ...SQL_CLIENT_MODULES].map((module) => [
    module.specifier,
    renderDevOnlyStub(module, `${module.specifier} is stubbed in this bundle.`),
  ]),
)

// Exact specifiers, as the deploy builds filter. On Bun 1.3.14 a catch-all filter
// that returns undefined for the rest resolves the server's `@guren/orm` import
// through the root tsconfig paths into src instead of dist.
const stubFilter = new RegExp(
  `^(?:${Object.keys(stubs).map((specifier) => specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})$`,
)

const result = await Bun.build({
  entrypoints: [entry],
  target: 'node',
  throw: false,
  metafile: true,
  minify: BUN_DEPLOY_MINIFY,
  define,
  plugins: [
    {
      name: 'deploy-stubs',
      setup(build) {
        build.onResolve({ filter: stubFilter }, (args) => ({ path: args.path, namespace: 'deploy-stub' }))
        build.onLoad({ filter: /.*/, namespace: 'deploy-stub' }, (args) => ({
          contents: stubs[args.path]!,
          loader: 'js',
        }))
      },
    },
  ],
})

const text = result.success ? await result.outputs[0]!.text() : ''
const report: BundleReport = {
  success: result.success,
  logs: result.logs.map(String),
  inputs: Object.keys(result.metafile?.inputs ?? {}),
  parseFont: text.includes('parseFont'),
}
console.log(JSON.stringify(report))
