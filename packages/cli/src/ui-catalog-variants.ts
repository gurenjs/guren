/**
 * The prop values the catalog renders each component with. `tests/ui-catalog.test.ts` pins them to the
 * unions the shipped templates export, so a template that gains a variant fails until the catalog shows it.
 */
export const UI_CATALOG_VARIANTS = {
  buttonVariants: ['primary', 'secondary', 'danger', 'ghost'],
  buttonSizes: ['md', 'sm'],
  alertTones: ['ok', 'warn', 'danger'],
  /** A subset of `FieldInput`: `hidden` renders nothing to look at, `file` and `password` look like `text`. */
  fieldInputs: ['text', 'email', 'textarea', 'select', 'number', 'date', 'checkbox'],
} as const
