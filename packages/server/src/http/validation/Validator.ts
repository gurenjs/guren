import type { ValidationRule, ValidationResult, ValidatorOptions } from './types'

/**
 * Field validator builder.
 */
export class FieldValidator {
  private _rules: ValidationRule[] = []
  private isNullable = false
  private isSometimes = false
  private bailOnFirstError = true
  private conditions: Array<(data: Record<string, unknown>) => boolean> = []

  constructor(private field: string) {}

  /**
   * Add a validation rule.
   */
  rule(rule: ValidationRule): this {
    this._rules.push(rule)
    return this
  }

  /**
   * Add multiple validation rules.
   */
  rules(...rules: ValidationRule[]): this {
    this._rules.push(...rules)
    return this
  }

  /**
   * Mark field as nullable (allows null values).
   */
  nullable(): this {
    this.isNullable = true
    return this
  }

  /**
   * Only validate if field is present.
   */
  sometimes(): this {
    this.isSometimes = true
    return this
  }

  /**
   * Stop validation on first error.
   */
  bail(): this {
    this.bailOnFirstError = true
    return this
  }

  /**
   * Continue validation even after errors.
   */
  continueOnError(): this {
    this.bailOnFirstError = false
    return this
  }

  /**
   * Add a condition - only validate if condition is true.
   */
  when(condition: (data: Record<string, unknown>) => boolean): this {
    this.conditions.push(condition)
    return this
  }

  /**
   * Add a condition - only validate if condition is false.
   */
  unless(condition: (data: Record<string, unknown>) => boolean): this {
    this.conditions.push((data) => !condition(data))
    return this
  }

  /**
   * Validate the field.
   */
  async validate(
    value: unknown,
    data: Record<string, unknown>,
    options: ValidatorOptions = {}
  ): Promise<string[]> {
    const errors: string[] = []

    // Check conditions
    for (const condition of this.conditions) {
      if (!condition(data)) {
        return []
      }
    }

    // Check sometimes
    if (this.isSometimes && (value === undefined || !(this.field in data))) {
      return []
    }

    // Check nullable
    if (this.isNullable && (value === null || value === undefined)) {
      return []
    }

    const attribute = options.attributes?.[this.field] ?? this.field

    for (const rule of this._rules) {
      const result = await rule(value, this.field, data)

      if (result !== true) {
        const message = this.formatMessage(result, attribute, options)
        errors.push(message)

        if (this.bailOnFirstError) {
          break
        }
      }
    }

    return errors
  }

  /**
   * Format error message.
   */
  private formatMessage(
    message: string,
    attribute: string,
    options: ValidatorOptions
  ): string {
    // Check for custom message
    const customKey = `${this.field}.${message}`
    if (options.messages?.[customKey]) {
      return options.messages[customKey].replace(':attribute', attribute)
    }
    if (options.messages?.[this.field]) {
      return options.messages[this.field].replace(':attribute', attribute)
    }

    return message.replace(':attribute', attribute)
  }

  /**
   * Get the field name.
   */
  getField(): string {
    return this.field
  }
}

/**
 * Validator class for validating data against rules.
 *
 * @example
 * ```typescript
 * import { Validator, required, email, min } from '@guren/server'
 *
 * const validator = new Validator()
 *   .field('name', required(), min(2))
 *   .field('email', required(), email())
 *   .field('password', required(), min(8))
 *   .field('password_confirmation', required())
 *
 * const result = await validator.validate(data)
 * if (!result.success) {
 *   console.log(result.errors)
 * }
 * ```
 */
export class Validator {
  private fields: Map<string, FieldValidator> = new Map()
  private options: ValidatorOptions = {}

  /**
   * Create a new validator.
   */
  constructor(options: ValidatorOptions = {}) {
    this.options = options
  }

  /**
   * Add a field with rules.
   */
  field(name: string, ...rules: ValidationRule[]): this {
    const fieldValidator = new FieldValidator(name)
    for (const rule of rules) {
      fieldValidator.rule(rule)
    }
    this.fields.set(name, fieldValidator)
    return this
  }

  /**
   * Add a field validator.
   */
  addField(validator: FieldValidator): this {
    this.fields.set(validator.getField(), validator)
    return this
  }

  /**
   * Get a field validator for fluent configuration.
   */
  for(name: string): FieldValidator {
    let fieldValidator = this.fields.get(name)
    if (!fieldValidator) {
      fieldValidator = new FieldValidator(name)
      this.fields.set(name, fieldValidator)
    }
    return fieldValidator
  }

  /**
   * Set custom error messages.
   */
  messages(messages: Record<string, string>): this {
    this.options.messages = { ...this.options.messages, ...messages }
    return this
  }

  /**
   * Set custom attribute names.
   */
  attributes(attributes: Record<string, string>): this {
    this.options.attributes = { ...this.options.attributes, ...attributes }
    return this
  }

  /**
   * Validate data.
   */
  async validate(data: Record<string, unknown>): Promise<ValidationResult> {
    const errors: Record<string, string[]> = {}

    for (const [field, validator] of this.fields) {
      const value = data[field]
      const fieldErrors = await validator.validate(value, data, this.options)

      if (fieldErrors.length > 0) {
        errors[field] = fieldErrors
      }
    }

    if (Object.keys(errors).length > 0) {
      return { success: false, errors }
    }

    // Extract validated data
    const validatedData: Record<string, unknown> = {}
    for (const field of this.fields.keys()) {
      if (field in data) {
        validatedData[field] = data[field]
      }
    }

    return { success: true, data: validatedData }
  }

  /**
   * Validate and throw if invalid.
   */
  async validateOrThrow(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await this.validate(data)

    if (!result.success) {
      // Import dynamically to avoid circular dependency
      const { ValidationException } = await import('../../errors')
      throw new ValidationException(result.errors!)
    }

    return result.data!
  }

  /**
   * Create a new validator from rules object.
   */
  static make(rules: Record<string, ValidationRule[]>, options: ValidatorOptions = {}): Validator {
    const validator = new Validator(options)

    for (const [field, fieldRules] of Object.entries(rules)) {
      validator.field(field, ...fieldRules)
    }

    return validator
  }
}

/**
 * Create a new validator.
 */
export function createValidator(options: ValidatorOptions = {}): Validator {
  return new Validator(options)
}

/**
 * Quick validate function.
 */
export async function quickValidate(
  data: Record<string, unknown>,
  rules: Record<string, ValidationRule[]>,
  options: ValidatorOptions = {}
): Promise<ValidationResult> {
  const validator = Validator.make(rules, options)
  return validator.validate(data)
}

/**
 * Quick validate and throw function.
 */
export async function quickValidateOrThrow(
  data: Record<string, unknown>,
  rules: Record<string, ValidationRule[]>,
  options: ValidatorOptions = {}
): Promise<Record<string, unknown>> {
  const validator = Validator.make(rules, options)
  return validator.validateOrThrow(data)
}
