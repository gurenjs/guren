// The bindings web/wrangler.jsonc declares, as the structural minimum app code
// calls. `@cloudflare/workers-types` stays out of the app's type graph.

export interface AssetsBindingLike {
  fetch(input: string | URL | Request): Promise<Response>
}

export interface WorkersEnv {
  DB: unknown
  ASSETS: AssetsBindingLike
}
