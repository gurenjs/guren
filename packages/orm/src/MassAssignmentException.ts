/**
 * Thrown when mass assignment receives fields it must not write. Silently
 * discarding them hides bugs (a typo'd fillable entry surfaces as a NOT NULL
 * violation much later) and can mask injection attempts, so models fail
 * loudly instead.
 *
 * `reason` distinguishes the two rules that throw:
 * - `'not-fillable'` — the field is outside the model's `fillable` allowlist.
 * - `'denied'` — the field is in the model's `deniedFields()` (e.g. a
 *   credential column on an authenticatable model) and can never be
 *   mass-assigned, `fillable` notwithstanding.
 */
export class MassAssignmentException extends Error {
  readonly model: string
  readonly fields: string[]
  readonly reason: 'not-fillable' | 'denied'

  constructor(model: string, fields: string[], options?: { reason?: 'not-fillable' | 'denied' }) {
    const reason = options?.reason ?? 'not-fillable'
    const list = fields.map((field) => `"${field}"`).join(', ')
    const remediation =
      reason === 'denied'
        ? `These are protected columns (e.g. credential fields) and can never be mass-assigned — ` +
          `not even via ${model}.fillable. Pass the plain input field (e.g. \`password\`) and let ` +
          `the model derive them, or use ${model}.forceCreate()/forceUpdate() for trusted ` +
          `server-side values such as \`passwordHash: 'oauth:...'\`.`
        : `Add them to fillable, or use ${model}.forceCreate()/forceUpdate() for trusted ` +
          `server-side data.`
    super(
      `${model}: mass assignment blocked for field(s) ${list}. ${remediation} ` +
        `Never call forceCreate/forceUpdate with request input.`,
    )
    this.name = 'MassAssignmentException'
    this.model = model
    this.fields = fields
    this.reason = reason
  }
}
