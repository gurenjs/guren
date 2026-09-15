/**
 * The declared environment (RFC 0027 §1): one schema, validated at boot by
 * ConfigServiceProvider, by the CLI, and by a connection thunk run outside an
 * application, all through {@link EnvSchema.parse}. A blank value is unset for
 * every builder, which is what `guren/no-nullish-env-default` exists to catch
 * in hand-written reads.
 */
import { AGENT_REDACTED } from '../agent/redact'

/**
 * The application's validated environment. Empty here; an app's `config/env.ts`
 * fills it: `declare module '@guren/core' { interface AppEnv extends InferEnv<typeof env> {} }`.
 */
// oxlint-disable-next-line typescript/no-empty-object-type -- an augmentation target, filled by the app
export interface AppEnv {}

/** The subset of Standard Schema v1 that `Env.custom()` calls; zod 4 implements it. */
export interface StandardSchemaV1<Output = unknown> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    readonly validate: (value: unknown) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>
  }
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> }

/** Values read ahead of `process.env`: the Workers env, a test's overrides. Non-string values are ignored. */
export type EnvSource = Readonly<Record<string, unknown>>

export interface EnvProblem {
  readonly key: string
  readonly message: string
}

export interface EnvParseOptions {
  /** `report` collects problems instead of throwing, for introspection and the CLI. */
  readonly mode?: 'throw' | 'report'
}

export interface ParsedEnv<Values> {
  readonly values: Values
  readonly problems: readonly EnvProblem[]
  /** Keys whose value is the redacted placeholder: unset and required, or invalid. */
  readonly unset: ReadonlySet<string>
}

type Presence = 'required' | 'optional' | 'defaulted' | 'production'
type Coerced<T> = { readonly value: T } | { readonly problem: string }

interface EnvVarState<T> {
  readonly coerce: (raw: string) => Coerced<T>
  readonly choices?: readonly string[]
  readonly presence: Presence
  readonly fallback?: T
  readonly emptyAllowed: boolean
  readonly isSecret: boolean
  readonly description?: string
}

/** One declared variable. Immutable: every modifier returns a new instance. */
export class EnvVar<T, P extends Presence = 'required'> {
  /** Carries `P` into the type; never set at runtime. */
  declare readonly presenceType: P

  constructor(private readonly state: EnvVarState<T>) {}

  /** Unset resolves to `undefined`. */
  optional(): EnvVar<T, 'optional'> {
    return new EnvVar({ ...this.state, presence: 'optional' })
  }

  /** Unset, blank included, resolves to `value`. */
  default(value: T): EnvVar<T, 'defaulted'> {
    return new EnvVar({ ...this.state, presence: 'defaulted', fallback: value })
  }

  /** Required only when `NODE_ENV` is `production`; `undefined` when unset elsewhere. */
  requiredInProduction(): EnvVar<T, 'production'> {
    return new EnvVar({ ...this.state, presence: 'production' })
  }

  /** Treat `FOO=` as the value `''` rather than as unset. */
  allowEmpty(): EnvVar<T, P> {
    return new EnvVar({ ...this.state, emptyAllowed: true })
  }

  /** Never echo the value, in a problem message or anywhere a schema is printed. */
  secret(): EnvVar<T, P> {
    return new EnvVar({ ...this.state, isSecret: true })
  }

  describe(text: string): EnvVar<T, P> {
    return new EnvVar({ ...this.state, description: text })
  }

  get isSecret(): boolean {
    return this.state.isSecret
  }

  get description(): string | undefined {
    return this.state.description
  }

  /** The `.default()` value; `undefined` unless `presence` is `defaulted`. */
  get defaultValue(): T | undefined {
    return this.state.fallback
  }

  /** The values an `Env.enum()` admits; `undefined` for every other builder. */
  get choices(): readonly string[] | undefined {
    return this.state.choices
  }

  /** @internal */
  resolve(raw: string | undefined, production: boolean): Coerced<T | undefined> | { readonly unset: true } {
    const { presence } = this.state
    if (raw === undefined || (raw === '' && !this.state.emptyAllowed)) {
      if (presence === 'defaulted') return { value: this.state.fallback }
      if (presence === 'optional' || (presence === 'production' && !production)) return { value: undefined }
      return { unset: true }
    }
    return this.state.coerce(raw)
  }
}

// Builders pass `T` explicitly: inferred from the coerce callback it widens to `T | undefined`.
function envVar<T>(coerce: (raw: string) => Coerced<T>, choices?: readonly string[]): EnvVar<T> {
  return new EnvVar<T>({ coerce, choices, presence: 'required', emptyAllowed: false, isSecret: false })
}

const PORT_PATTERN = /^\d+$/u

export const Env = {
  string: (): EnvVar<string> => envVar<string>((raw) => ({ value: raw })),

  url: (): EnvVar<string> => envVar<string>((raw) => {
    try {
      new URL(raw)
      return { value: raw }
    } catch {
      return { problem: 'is not a URL' }
    }
  }),

  number: (): EnvVar<number> => envVar<number>((raw) => {
    const value = Number(raw)
    return raw.trim() !== '' && Number.isFinite(value) ? { value } : { problem: 'is not a number' }
  }),

  port: (): EnvVar<number> => envVar<number>((raw) => {
    const value = Number(raw)
    return PORT_PATTERN.test(raw) && value >= 1 && value <= 65535 ? { value } : { problem: 'is not a port' }
  }),

  boolean: (): EnvVar<boolean> => envVar<boolean>((raw) => {
    const normalized = raw.toLowerCase()
    if (normalized === 'true' || normalized === '1') return { value: true }
    if (normalized === 'false' || normalized === '0') return { value: false }
    return { problem: 'is not a boolean (true, false, 1 or 0)' }
  }),

  enum: <const Values extends readonly [string, ...string[]]>(values: Values): EnvVar<Values[number]> =>
    envVar<Values[number]>((raw) => (values as readonly string[]).includes(raw)
      ? { value: raw as Values[number] }
      : { problem: `is not one of: ${values.join(', ')}` }, Object.freeze([...values])),

  /**
   * Synchronous validators only: `parse()` also runs where nothing can await it
   * (the CLI, a connection thunk), so a Promise result is reported as a problem.
   */
  custom: <Output>(schema: StandardSchemaV1<Output>): EnvVar<Output> => envVar<Output>((raw) => {
    const result = schema['~standard'].validate(raw)
    if (result instanceof Promise) {
      return { problem: 'has an asynchronous validator; Env.custom() accepts synchronous validators only' }
    }
    if ('value' in result && !result.issues) {
      return { value: result.value }
    }
    return { problem: `is invalid: ${(result.issues ?? []).map((issue) => issue.message).join('; ')}` }
  }),
}

// oxlint-disable-next-line typescript/no-explicit-any -- the variance-free upper bound for any declared variable
export type EnvVars = Readonly<Record<string, EnvVar<any, Presence>>>

type ValueOf<V> = V extends EnvVar<infer T, infer P>
  ? P extends 'optional' | 'production' ? T | undefined : T
  : never

export type InferEnvVars<Vars extends EnvVars> = { readonly [K in keyof Vars]: ValueOf<Vars[K]> }

/** The values a schema validates to, for `interface AppEnv extends InferEnv<typeof env> {}`. */
export type InferEnv<Schema> = Schema extends EnvSchema<infer Vars> ? InferEnvVars<Vars> : never

export class EnvValidationError extends Error {
  constructor(readonly problems: readonly EnvProblem[]) {
    const width = Math.max(...problems.map((problem) => problem.key.length)) + 2
    const lines = problems.map((problem) => `  ${problem.key.padEnd(width)}${problem.message}`)
    super(`[guren] Invalid environment (${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}):\n${lines.join('\n')}`)
    this.name = 'EnvValidationError'
  }
}

export class EnvSchema<Vars extends EnvVars = EnvVars> {
  constructor(readonly vars: Vars) {}

  /**
   * Looks up each declared key in `source`, then `process.env`, and does not
   * cache: `process.env` keeps its identity while tests and platforms mutate it.
   */
  parse(source?: EnvSource, options: EnvParseOptions = {}): ParsedEnv<InferEnvVars<Vars>> {
    // The literal form the deploy plugins' `--define` substitutes (tests/env-gate-form.test.ts).
    const production = typeof process !== 'undefined' && process.env.NODE_ENV === 'production'
    const values: Record<string, unknown> = {}
    const problems: EnvProblem[] = []

    for (const [key, spec] of Object.entries(this.vars)) {
      const raw = readRaw(source, key)
      const outcome = spec.resolve(raw, production)

      if ('value' in outcome) {
        values[key] = outcome.value
        continue
      }

      const shown = spec.isSecret || raw === undefined ? 'value' : JSON.stringify(raw)
      problems.push({ key, message: 'unset' in outcome ? 'required, not set' : `${shown} ${outcome.problem}` })
      values[key] = AGENT_REDACTED
    }

    if (problems.length > 0 && (options.mode ?? 'throw') === 'throw') {
      throw new EnvValidationError(problems)
    }

    const unset = new Set(problems.map((problem) => problem.key))
    return { values: Object.freeze(values) as InferEnvVars<Vars>, problems, unset }
  }
}

function readRaw(source: EnvSource | undefined, key: string): string | undefined {
  const supplied = source?.[key]
  if (typeof supplied === 'string') return supplied
  return typeof process === 'undefined' ? undefined : process.env[key]
}

const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u

/**
 * Keys an app schema may not declare. `NODE_ENV` gates fold at bundle time only
 * as the exact `process.env.NODE_ENV` expression, and `GUREN_*` are framework
 * security gates and tooling flags (RFC 0027 §1). The oxlint rule keeps a copy.
 */
export function isRawEnvKey(key: string): boolean {
  return key === 'NODE_ENV' || key.startsWith('GUREN_')
}

export function defineEnv<const Vars extends EnvVars>(vars: Vars): EnvSchema<Vars> {
  for (const key of Object.keys(vars)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new Error(`[guren] defineEnv(): "${key}" is not an environment variable name (A-Z, 0-9 and _).`)
    }
    if (isRawEnvKey(key)) {
      throw new Error(
        `[guren] defineEnv(): ${key} cannot be declared. NODE_ENV stays a raw \`process.env.NODE_ENV\` read so `
        + 'bundlers can fold production gates, and GUREN_* are framework security gates, not app settings.',
      )
    }
  }
  return new EnvSchema(vars)
}
