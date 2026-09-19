/** What a drizzle column declared with `{ enum: [...] }` carries, in any dialect. */
interface EnumColumn<V extends string> {
  enumValues: readonly [V, ...V[]] | undefined
}

/** Its own literal shape, not the SDK's question union: intersecting with the union widens the option keys to `string`. */
export interface ChoiceQuestion<V extends string> {
  readonly type: 'choice'
  readonly instructions: string
  readonly criteria: Readonly<Record<V, string | null>>
}

/**
 * A `choice` question whose options are a column's enum values, so the answer's
 * `choice` is typed as the column and a value added to the enum reaches the
 * model without touching the question.
 */
export function choiceFrom<const V extends string>(
  column: EnumColumn<V>,
  instructions: string,
  describe: Partial<Record<V, string>> = {},
): ChoiceQuestion<V> {
  const values = column.enumValues
  if (!values?.length) throw new Error('choiceFrom() needs a column declared with an enum.')
  const criteria = Object.fromEntries(values.map((value) => [value, describe[value] ?? null])) as Record<V, string | null>
  return { type: 'choice', instructions, criteria }
}
