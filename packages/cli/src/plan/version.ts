/** Apart from `schema.ts` so the rendered page can name it without bundling the validator. */
export const PLAN_VERSION = 2

/** Every version this CLI reads. A version 1 plan holds no `providers` or `config` section (RFC 0040 §5). */
export const SUPPORTED_PLAN_VERSIONS: readonly number[] = [1, 2]
