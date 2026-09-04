/** Returns `true` when valid, or the error message. */
export type ValidationRule<T = unknown> = (
  value: T,
  field: string,
  data: Record<string, unknown>
) => true | string | Promise<true | string>

/** Validation rule definition. */
export interface RuleDefinition {
  name: string
  validate: ValidationRule
  message?: string
}

/** Validation result. */
export interface ValidationResult {
  success: boolean
  data?: Record<string, unknown>
  errors?: Record<string, string[]>
}

/** File validation options. */
export interface FileValidationOptions {
  /** In bytes. */
  maxSize?: number

  mimes?: string[]

  extensions?: string[]

  /** In bytes. */
  minSize?: number
}

/** Image validation options. */
export interface ImageValidationOptions extends FileValidationOptions {
  /** In pixels. */
  maxWidth?: number

  /** In pixels. */
  maxHeight?: number

  /** In pixels. */
  minWidth?: number

  /** In pixels. */
  minHeight?: number

  /** Required aspect ratio (width/height). */
  ratio?: number

  ratioTolerance?: number
}

/** Validator options. */
export interface ValidatorOptions {
  /** Stop on the first error for each field. @default true */
  stopOnFirstError?: boolean

  messages?: Record<string, string>

  /** Attribute names substituted into error messages. */
  attributes?: Record<string, string>
}

/** File-like interface for validation. */
export interface FileLike {
  name: string
  size: number
  type: string
}
