/**
 * The stylesheet *source* path the dev asset configuration falls back to. A
 * leaf module because two sides must agree on it: `http/inertia-assets.ts`
 * publishes it into `GUREN_INERTIA_STYLES` and `mvc/inertia/InertiaEngine.ts`
 * drops exactly this path when a dev server owns the script entry. Importing
 * either from the other would cross the Workers/Lambda boundary or cycle.
 */
export const DEFAULT_DEV_STYLES_ENTRY = '/resources/css/app.css'
