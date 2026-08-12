/**
 * The stylesheet *source* path the dev asset configuration falls back to.
 *
 * Lives in a leaf module because two sides read it and must agree: the dev
 * configuration in `http/inertia-assets.ts` publishes it into
 * `GUREN_INERTIA_STYLES`, and the document renderer in
 * `mvc/inertia/InertiaEngine.ts` drops exactly this path again when a dev
 * server owns the script entry (the compiled CSS then arrives through the
 * module graph). Importing either of those modules from the other would drag
 * runtime-specific dependencies across the Workers/Lambda boundary or create
 * an import cycle.
 */
export const DEFAULT_DEV_STYLES_ENTRY = '/resources/css/app.css'
