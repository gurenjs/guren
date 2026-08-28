/**
 * SSR stand-in for `mermaid`, wired up by the alias in vite.config.ts.
 *
 * Diagrams render in a browser-only effect (pages/Docs/Show.tsx), so nothing
 * here is ever called — the module exists so the SSR bundle the Cloudflare
 * Worker ships does not have to carry a diagram library it cannot use.
 */
function unreachable(): never {
  throw new Error('mermaid is browser-only; the SSR bundle stubs it out.')
}

export default {
  initialize: unreachable,
  render: unreachable,
}
