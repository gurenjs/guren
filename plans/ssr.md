# Server-Side Rendering Implementation Plan

1. **Audit Existing Flow**  
   - Inspect `packages/server/src/mvc/inertia/InertiaEngine.ts`, `packages/server/src/plugins/providers/InertiaViewProvider.ts`, and the inertia asset helpers in `packages/server/src/http/inertia-assets.ts` and `packages/server/src/http/dev-assets.ts` to catalog all touchpoints that will need SSR awareness.  
   - Confirm how controllers and view providers wire the inertia engine today to ensure any new behavior remains backward compatible.

2. **Add Server Renderer API**  
   - Extend `packages/inertia-client` with a `renderInertiaServer` helper that wraps `createInertiaApp` using React’s `renderToString`, mirroring the Context7 guidance.  
   - Ensure the helper accepts `{ page, resolve }`, returns the rendered HTML plus head metadata, and can load components via Vite’s glob in production or dev environments.

3. **Expand Build Outputs**  
   - Update the Vite plugin (`packages/server/src/vite/plugin.ts`) so projects produce both client and SSR bundles, including a server manifest.  
   - Enhance `configureInertiaAssets` to expose env variables (`GUREN_INERTIA_SSR_ENTRY`, `GUREN_INERTIA_SSR_MANIFEST`) that point to the generated SSR artifacts in production, while mapping to dev-server endpoints during development.

4. **Enable SSR in Inertia Engine**  
   - Adjust `InertiaEngine` to prefer SSR when the bundle/env hints exist: dynamically import the SSR renderer, execute it with the assembled page payload, and inject the rendered markup into the HTML shell.  
   - Maintain the current JSON response behavior for X-Inertia requests and fall back to client-only rendering if SSR setup fails.

5. **Wire Example App Defaults**  
   - Document a default `resources/js/ssr.tsx` entry in the blog example and ensure `examples/blog/src/main.ts` loads the SSR env hints.  
   - Provide configuration hooks so apps can override the resolver or renderer without hacking framework internals.

6. **Tests and Documentation**  
   - Add unit/feature coverage for the updated inertia engine, including stubbing the SSR renderer.  
   - Create an end-to-end smoke test in the example app, and update docs/README with build instructions (`bunx vite build --ssr`) plus troubleshooting guidance.
