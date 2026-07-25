// The full shiki bundle (every grammar + the oniguruma engine) is reached
// only by the filesystem docs renderer used in local dev — production serves
// prerendered HTML, so Workers builds alias `shiki` here to keep ~2 MB of
// grammars out of the worker. The blog's save-time renderer imports
// `shiki/core` plus individual grammars and is unaffected.
export function codeToHtml() {
  throw new Error('The full shiki bundle is unavailable on Cloudflare Workers — docs HTML is prerendered at build time.')
}

export default { codeToHtml }
