/**
 * Thrown when mass assignment receives fields it must not write. Discarding
 * them silently hides bugs and can mask injection attempts, so models throw.
 * `reason` is `'not-fillable'` (outside the `fillable` allowlist) or
 * `'denied'` (in `deniedFields()`, unassignable whatever `fillable` says).
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
