/**
 * What `Model`, `QueryBuilder` and the adapters share without importing each
 * other, kept out of the package entry point. The keys live here rather than on
 * either class because `Model` names one as a computed static key: evaluated
 * while the two modules' import cycle is still unwinding, a key declared in the
 * other one is in its temporal dead zone.
 */

/** Bulk update with an already-filtered, already-prepared payload. */
export const PREPARED_UPDATE = Symbol('guren.orm.preparedUpdate')

/** Freezes the conditions applied so far as the model's global scopes. */
export const SEAL_SCOPES = Symbol('guren.orm.sealScopes')

/** The model's one read-transform pass over a result set. */
export const READ_TRANSFORMS = Symbol('guren.orm.readTransforms')

/** Rows as the adapter read them, for the joins a relation loader makes. */
export const RAW_RESULTS = Symbol('guren.orm.rawResults')

/**
 * Keys per IN list where nothing better is known: the adapter names no figure of
 * its own, or it cannot place the dialect. A relation load binds one variable per
 * key, against a limit the driver sets, and 500 is under every one of them —
 * SQLite's 999 on a build older than 3.32 included.
 */
export const DEFAULT_IN_LIST_SIZE = 500
