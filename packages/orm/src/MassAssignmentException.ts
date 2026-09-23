/**
 * Thrown when mass assignment receives fields it must not write. Discarding
 * them silently hides bugs and can mask injection attempts, so models throw.
 * `reason` is `'denied'` for a field in `deniedFields()`, unassignable whatever
 * `fillable` says, and `'not-fillable'` for every other refusal: a field outside
 * `fillable`, or a `set` the allowlist does not admit (RFC 0031).
 */
export class MassAssignmentException extends Error {
  readonly model: string
  readonly fields: string[]
  readonly reason: 'not-fillable' | 'denied'

  /**
   * `set` names the `create(data, { set })` rule that refused the fields and
   * only changes the message: `'no-fillable'` (the model declares no `fillable`),
   * `'id'`, `'fillable'` (a `set` key a request may already write) or
   * `'conflict'` (a key in both `data` and `set`).
   */
  constructor(
    model: string,
    fields: string[],
    options?: { reason?: 'not-fillable'; set?: SetRule } | { reason: 'denied' },
  ) {
    const reason = options?.reason ?? 'not-fillable'
    const set = options && 'set' in options ? options.set : undefined
    const list = fields.map((field) => `"${field}"`).join(', ')
    super(
      `${model}: mass assignment blocked for field(s) ${list}. ${remediation(model, fields, reason, set)} ` +
        `Never pass request input to forceCreate/forceUpdate or spread it into set.`,
    )
    this.name = 'MassAssignmentException'
    this.model = model
    this.fields = fields
    this.reason = reason
  }
}

type SetRule = 'no-fillable' | 'id' | 'fillable' | 'conflict'

function remediation(model: string, fields: string[], reason: 'not-fillable' | 'denied', set: SetRule | undefined): string {
  if (reason === 'denied') {
    return `These are protected columns (e.g. credential fields) and can never be mass-assigned, ` +
      `not even through ${model}.fillable or set. Pass the plain input field (e.g. \`password\`) and let ` +
      `the model derive them, or use ${model}.forceCreate()/forceUpdate() for trusted ` +
      `server-side values such as \`passwordHash: 'oauth:...'\`.`
  }
  switch (set) {
    case 'no-fillable':
      return `${model} declares no fillable, so every column is already writable through the data ` +
        `and set would keep nothing apart. Declare fillable with the columns a request may set.`
    case 'id':
      return `set cannot carry the primary key: a server-chosen id is a system write, which belongs ` +
        `in ${model}.forceCreate().`
    case 'fillable':
      return `They are in ${model}.fillable, so a request may already set them: pass them in the data. ` +
        `A column the server sets must not be fillable, or every other write would accept it from a request.`
    case 'conflict':
      return `They are set by the server in this call, so they must not also arrive in the data.`
    default:
      return `Add them to fillable if a request may set them; if the server chooses the value, ` +
        `name it in the set option of ${model}.create() or ${model}.update(): { set: { ${fields.join(', ')} } }.`
  }
}
