/**
 * Thrown when mass assignment receives fields outside the model's
 * `fillable` allowlist. Silently discarding them hides bugs (a typo'd
 * fillable entry surfaces as a NOT NULL violation much later) and can
 * mask injection attempts, so strict models fail loudly instead.
 */
export class MassAssignmentException extends Error {
  readonly model: string
  readonly fields: string[]

  constructor(model: string, fields: string[]) {
    const list = fields.map((field) => `"${field}"`).join(', ')
    super(
      `${model}: mass assignment blocked for field(s) ${list} — not listed in ${model}.fillable. ` +
        `Add them to fillable, use ${model}.forceCreate()/forceUpdate() for trusted server-side data, ` +
        `or set \`static strictFillable = false\` to restore silent discarding.`,
    )
    this.name = 'MassAssignmentException'
    this.model = model
    this.fields = fields
  }
}
