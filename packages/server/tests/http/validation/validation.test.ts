import { describe, test, expect } from 'bun:test'
import {
  Validator,
  FieldValidator,
  createValidator,
  quickValidate,
  quickValidateOrThrow,
  required,
  nullable,
  requiredIf,
  requiredUnless,
  requiredWith,
  requiredWithout,
  string,
  numeric,
  integer,
  boolean,
  array,
  object,
  email,
  url,
  uuid,
  ip,
  ipv4,
  ipv6,
  json,
  alpha,
  alphaNum,
  alphaDash,
  regex,
  min,
  max,
  between,
  size,
  inValues,
  notIn,
  confirmed,
  same,
  different,
  date,
  dateFormat,
  after,
  afterOrEqual,
  before,
  beforeOrEqual,
  startsWith,
  endsWith,
  file,
  image,
  mimes,
  maxFileSize,
  minFileSize,
  custom,
  unique,
  exists,
} from '../../../src/http/validation'
import { ValidationException } from '../../../src/errors'

describe('Validation Rules', () => {
  describe('required', () => {
    test('passes for non-empty value', async () => {
      const rule = required()
      expect(await rule('hello', 'field', {})).toBe(true)
      expect(await rule(123, 'field', {})).toBe(true)
      expect(await rule(['a'], 'field', {})).toBe(true)
    })

    test('fails for undefined', async () => {
      const rule = required()
      expect(await rule(undefined, 'field', {})).toContain('required')
    })

    test('fails for null', async () => {
      const rule = required()
      expect(await rule(null, 'field', {})).toContain('required')
    })

    test('fails for empty string', async () => {
      const rule = required()
      expect(await rule('', 'field', {})).toContain('required')
      expect(await rule('   ', 'field', {})).toContain('required')
    })

    test('fails for empty array', async () => {
      const rule = required()
      expect(await rule([], 'field', {})).toContain('required')
    })
  })

  describe('requiredIf', () => {
    test('required when condition met', async () => {
      const rule = requiredIf('role', 'admin')
      expect(await rule('', 'field', { role: 'admin' })).toContain('required')
      expect(await rule('value', 'field', { role: 'admin' })).toBe(true)
    })

    test('not required when condition not met', async () => {
      const rule = requiredIf('role', 'admin')
      expect(await rule('', 'field', { role: 'user' })).toBe(true)
    })
  })

  describe('requiredUnless', () => {
    test('required when condition not met', async () => {
      const rule = requiredUnless('role', 'admin')
      expect(await rule('', 'field', { role: 'user' })).toContain('required')
    })

    test('not required when condition met', async () => {
      const rule = requiredUnless('role', 'admin')
      expect(await rule('', 'field', { role: 'admin' })).toBe(true)
    })
  })

  describe('requiredWith', () => {
    test('required when other field present', async () => {
      const rule = requiredWith('email')
      expect(await rule('', 'name', { email: 'test@example.com' })).toContain('required')
    })

    test('not required when other field absent', async () => {
      const rule = requiredWith('email')
      expect(await rule('', 'name', {})).toBe(true)
    })
  })

  describe('requiredWithout', () => {
    test('required when other field absent', async () => {
      const rule = requiredWithout('email')
      expect(await rule('', 'phone', {})).toContain('required')
    })

    test('not required when other field present', async () => {
      const rule = requiredWithout('email')
      expect(await rule('', 'phone', { email: 'test@example.com' })).toBe(true)
    })
  })

  describe('string', () => {
    test('passes for strings', async () => {
      const rule = string()
      expect(await rule('hello', 'field', {})).toBe(true)
      expect(await rule('', 'field', {})).toBe(true)
    })

    test('passes for null/undefined', async () => {
      const rule = string()
      expect(await rule(null, 'field', {})).toBe(true)
      expect(await rule(undefined, 'field', {})).toBe(true)
    })

    test('fails for non-strings', async () => {
      const rule = string()
      expect(await rule(123, 'field', {})).toContain('string')
      expect(await rule([], 'field', {})).toContain('string')
    })
  })

  describe('numeric', () => {
    test('passes for numbers', async () => {
      const rule = numeric()
      expect(await rule(123, 'field', {})).toBe(true)
      expect(await rule(12.5, 'field', {})).toBe(true)
      expect(await rule('123', 'field', {})).toBe(true)
      expect(await rule('12.5', 'field', {})).toBe(true)
    })

    test('fails for non-numeric', async () => {
      const rule = numeric()
      expect(await rule('abc', 'field', {})).toContain('number')
    })
  })

  describe('integer', () => {
    test('passes for integers', async () => {
      const rule = integer()
      expect(await rule(123, 'field', {})).toBe(true)
      expect(await rule('123', 'field', {})).toBe(true)
      expect(await rule(-5, 'field', {})).toBe(true)
    })

    test('fails for non-integers', async () => {
      const rule = integer()
      expect(await rule(12.5, 'field', {})).toContain('integer')
      expect(await rule('12.5', 'field', {})).toContain('integer')
    })
  })

  describe('boolean', () => {
    test('passes for boolean values', async () => {
      const rule = boolean()
      expect(await rule(true, 'field', {})).toBe(true)
      expect(await rule(false, 'field', {})).toBe(true)
      expect(await rule('true', 'field', {})).toBe(true)
      expect(await rule('false', 'field', {})).toBe(true)
      expect(await rule(1, 'field', {})).toBe(true)
      expect(await rule(0, 'field', {})).toBe(true)
    })

    test('fails for non-boolean', async () => {
      const rule = boolean()
      expect(await rule('yes', 'field', {})).toContain('boolean')
    })
  })

  describe('array', () => {
    test('passes for arrays', async () => {
      const rule = array()
      expect(await rule([], 'field', {})).toBe(true)
      expect(await rule([1, 2, 3], 'field', {})).toBe(true)
    })

    test('fails for non-arrays', async () => {
      const rule = array()
      expect(await rule({}, 'field', {})).toContain('array')
      expect(await rule('string', 'field', {})).toContain('array')
    })
  })

  describe('object', () => {
    test('passes for objects', async () => {
      const rule = object()
      expect(await rule({}, 'field', {})).toBe(true)
      expect(await rule({ a: 1 }, 'field', {})).toBe(true)
    })

    test('fails for arrays', async () => {
      const rule = object()
      expect(await rule([], 'field', {})).toContain('object')
    })
  })

  describe('email', () => {
    test('passes for valid emails', async () => {
      const rule = email()
      expect(await rule('test@example.com', 'field', {})).toBe(true)
      expect(await rule('user.name+tag@domain.co.uk', 'field', {})).toBe(true)
    })

    test('fails for invalid emails', async () => {
      const rule = email()
      expect(await rule('invalid', 'field', {})).toContain('email')
      expect(await rule('missing@domain', 'field', {})).toContain('email')
    })

    test('passes for empty values', async () => {
      const rule = email()
      expect(await rule('', 'field', {})).toBe(true)
      expect(await rule(null, 'field', {})).toBe(true)
    })
  })

  describe('url', () => {
    test('passes for valid URLs', async () => {
      const rule = url()
      expect(await rule('https://example.com', 'field', {})).toBe(true)
      expect(await rule('http://localhost:3000/path', 'field', {})).toBe(true)
    })

    test('fails for invalid URLs', async () => {
      const rule = url()
      expect(await rule('not-a-url', 'field', {})).toContain('URL')
    })
  })

  describe('uuid', () => {
    test('passes for valid UUIDs', async () => {
      const rule = uuid()
      expect(await rule('550e8400-e29b-41d4-a716-446655440000', 'field', {})).toBe(true)
    })

    test('fails for invalid UUIDs', async () => {
      const rule = uuid()
      expect(await rule('not-a-uuid', 'field', {})).toContain('UUID')
    })
  })

  describe('min', () => {
    test('passes for string length >= min', async () => {
      const rule = min(5)
      expect(await rule('hello', 'field', {})).toBe(true)
      expect(await rule('hello world', 'field', {})).toBe(true)
    })

    test('fails for string length < min', async () => {
      const rule = min(5)
      expect(await rule('hi', 'field', {})).toContain('5')
    })

    test('passes for number >= min', async () => {
      const rule = min(10)
      expect(await rule(10, 'field', {})).toBe(true)
      expect(await rule(15, 'field', {})).toBe(true)
    })

    test('fails for number < min', async () => {
      const rule = min(10)
      expect(await rule(5, 'field', {})).toContain('10')
    })

    test('works with arrays', async () => {
      const rule = min(2)
      expect(await rule([1, 2], 'field', {})).toBe(true)
      expect(await rule([1], 'field', {})).toContain('2')
    })
  })

  describe('max', () => {
    test('passes for string length <= max', async () => {
      const rule = max(5)
      expect(await rule('hi', 'field', {})).toBe(true)
      expect(await rule('hello', 'field', {})).toBe(true)
    })

    test('fails for string length > max', async () => {
      const rule = max(5)
      expect(await rule('hello world', 'field', {})).toContain('5')
    })

    test('works with numbers', async () => {
      const rule = max(10)
      expect(await rule(10, 'field', {})).toBe(true)
      expect(await rule(15, 'field', {})).toContain('10')
    })
  })

  describe('between', () => {
    test('passes for value in range', async () => {
      const rule = between(5, 10)
      expect(await rule('hello', 'field', {})).toBe(true)
      expect(await rule(7, 'field', {})).toBe(true)
    })

    test('fails for value out of range', async () => {
      const rule = between(5, 10)
      expect(await rule('hi', 'field', {})).toContain('5')
      expect(await rule(15, 'field', {})).toContain('10')
    })
  })

  describe('size', () => {
    test('passes for exact size', async () => {
      const rule = size(5)
      expect(await rule('hello', 'field', {})).toBe(true)
      expect(await rule(5, 'field', {})).toBe(true)
      expect(await rule([1, 2, 3, 4, 5], 'field', {})).toBe(true)
    })

    test('fails for different size', async () => {
      const rule = size(5)
      expect(await rule('hi', 'field', {})).toContain('5')
    })
  })

  describe('inValues', () => {
    test('passes for value in list', async () => {
      const rule = inValues(['a', 'b', 'c'])
      expect(await rule('a', 'field', {})).toBe(true)
    })

    test('fails for value not in list', async () => {
      const rule = inValues(['a', 'b', 'c'])
      expect(await rule('d', 'field', {})).toContain('invalid')
    })
  })

  describe('notIn', () => {
    test('passes for value not in list', async () => {
      const rule = notIn(['a', 'b', 'c'])
      expect(await rule('d', 'field', {})).toBe(true)
    })

    test('fails for value in list', async () => {
      const rule = notIn(['a', 'b', 'c'])
      expect(await rule('a', 'field', {})).toContain('invalid')
    })
  })

  describe('confirmed', () => {
    test('passes when confirmation matches', async () => {
      const rule = confirmed()
      expect(await rule('secret', 'password', { password_confirmation: 'secret' })).toBe(true)
    })

    test('fails when confirmation does not match', async () => {
      const rule = confirmed()
      expect(await rule('secret', 'password', { password_confirmation: 'different' })).toContain('confirmation')
    })
  })

  describe('same', () => {
    test('passes when values match', async () => {
      const rule = same('other')
      expect(await rule('value', 'field', { other: 'value' })).toBe(true)
    })

    test('fails when values differ', async () => {
      const rule = same('other')
      expect(await rule('value', 'field', { other: 'different' })).toContain('match')
    })
  })

  describe('different', () => {
    test('passes when values differ', async () => {
      const rule = different('other')
      expect(await rule('value', 'field', { other: 'different' })).toBe(true)
    })

    test('fails when values match', async () => {
      const rule = different('other')
      expect(await rule('value', 'field', { other: 'value' })).toContain('different')
    })
  })

  describe('date', () => {
    test('passes for valid dates', async () => {
      const rule = date()
      expect(await rule('2024-01-15', 'field', {})).toBe(true)
      expect(await rule('2024-01-15T12:00:00Z', 'field', {})).toBe(true)
    })

    test('fails for invalid dates', async () => {
      const rule = date()
      expect(await rule('not-a-date', 'field', {})).toContain('date')
    })
  })

  describe('after', () => {
    test('passes for date after reference', async () => {
      const rule = after('2024-01-01')
      expect(await rule('2024-06-15', 'field', {})).toBe(true)
    })

    test('fails for date before reference', async () => {
      const rule = after('2024-06-01')
      expect(await rule('2024-01-15', 'field', {})).toContain('after')
    })
  })

  describe('before', () => {
    test('passes for date before reference', async () => {
      const rule = before('2024-12-31')
      expect(await rule('2024-06-15', 'field', {})).toBe(true)
    })

    test('fails for date after reference', async () => {
      const rule = before('2024-01-01')
      expect(await rule('2024-06-15', 'field', {})).toContain('before')
    })
  })

  describe('regex', () => {
    test('passes for matching pattern', async () => {
      const rule = regex(/^[A-Z]{3}-\d{4}$/)
      expect(await rule('ABC-1234', 'field', {})).toBe(true)
    })

    test('fails for non-matching pattern', async () => {
      const rule = regex(/^[A-Z]{3}-\d{4}$/)
      expect(await rule('abc-1234', 'field', {})).toContain('format')
    })
  })

  describe('alpha', () => {
    test('passes for letters only', async () => {
      const rule = alpha()
      expect(await rule('hello', 'field', {})).toBe(true)
      expect(await rule('HelloWorld', 'field', {})).toBe(true)
    })

    test('fails for non-letters', async () => {
      const rule = alpha()
      expect(await rule('hello123', 'field', {})).toContain('letters')
    })
  })

  describe('alphaNum', () => {
    test('passes for letters and numbers', async () => {
      const rule = alphaNum()
      expect(await rule('hello123', 'field', {})).toBe(true)
    })

    test('fails for special characters', async () => {
      const rule = alphaNum()
      expect(await rule('hello@123', 'field', {})).toContain('letters and numbers')
    })
  })

  describe('alphaDash', () => {
    test('passes for alphanumeric with dashes and underscores', async () => {
      const rule = alphaDash()
      expect(await rule('hello_world-123', 'field', {})).toBe(true)
    })

    test('fails for other special characters', async () => {
      const rule = alphaDash()
      expect(await rule('hello@world', 'field', {})).toContain('dashes')
    })
  })

  describe('startsWith', () => {
    test('passes when value starts with prefix', async () => {
      const rule = startsWith('http', 'https')
      expect(await rule('https://example.com', 'field', {})).toBe(true)
    })

    test('fails when value does not start with prefix', async () => {
      const rule = startsWith('http', 'https')
      expect(await rule('ftp://example.com', 'field', {})).toContain('start with')
    })
  })

  describe('endsWith', () => {
    test('passes when value ends with suffix', async () => {
      const rule = endsWith('.jpg', '.png')
      expect(await rule('image.png', 'field', {})).toBe(true)
    })

    test('fails when value does not end with suffix', async () => {
      const rule = endsWith('.jpg', '.png')
      expect(await rule('image.gif', 'field', {})).toContain('end with')
    })
  })

  describe('json', () => {
    test('passes for valid JSON', async () => {
      const rule = json()
      expect(await rule('{"key": "value"}', 'field', {})).toBe(true)
      expect(await rule('["a", "b"]', 'field', {})).toBe(true)
    })

    test('fails for invalid JSON', async () => {
      const rule = json()
      expect(await rule('{invalid}', 'field', {})).toContain('JSON')
    })
  })

  describe('ip', () => {
    test('passes for valid IP addresses', async () => {
      const rule = ip()
      expect(await rule('192.168.1.1', 'field', {})).toBe(true)
    })

    test('fails for invalid IP addresses', async () => {
      const rule = ip()
      expect(await rule('999.999.999.999', 'field', {})).toContain('IP')
    })
  })

  describe('file', () => {
    test('passes for valid file', async () => {
      const rule = file({ maxSize: 1024 * 1024 })
      expect(await rule({ name: 'test.txt', size: 1024, type: 'text/plain' }, 'field', {})).toBe(true)
    })

    test('fails for file too large', async () => {
      const rule = file({ maxSize: 1024 })
      expect(await rule({ name: 'test.txt', size: 2048, type: 'text/plain' }, 'field', {})).toContain('exceed')
    })

    test('fails for invalid mime type', async () => {
      const rule = file({ mimes: ['image/jpeg', 'image/png'] })
      expect(await rule({ name: 'test.txt', size: 1024, type: 'text/plain' }, 'field', {})).toContain('type')
    })
  })

  describe('image', () => {
    test('passes for valid image', async () => {
      const rule = image()
      expect(await rule({ name: 'test.jpg', size: 1024, type: 'image/jpeg' }, 'field', {})).toBe(true)
    })

    test('fails for non-image', async () => {
      const rule = image()
      expect(await rule({ name: 'test.txt', size: 1024, type: 'text/plain' }, 'field', {})).toContain('image')
    })
  })

  describe('custom', () => {
    test('works with custom validation function', async () => {
      const rule = custom((value) => {
        return value === 'valid' ? true : 'Value must be "valid"'
      })
      expect(await rule('valid', 'field', {})).toBe(true)
      expect(await rule('invalid', 'field', {})).toBe('Value must be "valid"')
    })

    test('works with async validation', async () => {
      const rule = custom(async (value) => {
        await new Promise(resolve => setTimeout(resolve, 1))
        return (value as string).length > 3
      }, 'Value must be longer than 3 characters')

      expect(await rule('long', 'field', {})).toBe(true)
      expect(await rule('ab', 'field', {})).toBe('Value must be longer than 3 characters')
    })
  })

  describe('unique', () => {
    test('works with async unique check', async () => {
      const existingEmails = ['taken@example.com']
      const rule = unique(async (value) => !existingEmails.includes(value as string))

      expect(await rule('new@example.com', 'email', {})).toBe(true)
      expect(await rule('taken@example.com', 'email', {})).toContain('taken')
    })
  })

  describe('exists', () => {
    test('works with async exists check', async () => {
      const existingIds = [1, 2, 3]
      const rule = exists(async (value) => existingIds.includes(value as number))

      expect(await rule(1, 'id', {})).toBe(true)
      expect(await rule(999, 'id', {})).toContain('invalid')
    })
  })
})

describe('Validator', () => {
  describe('basic validation', () => {
    test('validates required fields', async () => {
      const validator = new Validator()
        .field('name', required())
        .field('email', required(), email())

      const result = await validator.validate({ name: 'John', email: 'john@example.com' })
      expect(result.success).toBe(true)
    })

    test('returns errors for invalid data', async () => {
      const validator = new Validator()
        .field('name', required())
        .field('email', required(), email())

      const result = await validator.validate({ name: '', email: 'invalid' })
      expect(result.success).toBe(false)
      expect(result.errors?.name).toBeDefined()
      expect(result.errors?.email).toBeDefined()
    })

    test('returns validated data on success', async () => {
      const validator = new Validator()
        .field('name', required())
        .field('age', numeric())

      const result = await validator.validate({ name: 'John', age: 25, extra: 'ignored' })
      expect(result.success).toBe(true)
      expect(result.data).toEqual({ name: 'John', age: 25 })
      expect(result.data?.extra).toBeUndefined()
    })
  })

  describe('custom messages', () => {
    test('uses custom error messages', async () => {
      const validator = new Validator()
        .field('email', required())
        .messages({
          email: 'Please provide your email address',
        })

      const result = await validator.validate({})
      expect(result.errors?.email?.[0]).toBe('Please provide your email address')
    })

    test('uses custom attribute names', async () => {
      const validator = new Validator()
        .field('dob', required())
        .attributes({
          dob: 'date of birth',
        })

      const result = await validator.validate({})
      expect(result.errors?.dob?.[0]).toContain('date of birth')
    })
  })

  describe('conditional validation', () => {
    test('validates when condition is true', async () => {
      const validator = createValidator()
      validator.for('admin_code')
        .rule(required())
        .when((data) => data.role === 'admin')

      const result = await validator.validate({ role: 'admin' })
      expect(result.success).toBe(false)
      expect(result.errors?.admin_code).toBeDefined()
    })

    test('skips validation when condition is false', async () => {
      const validator = createValidator()
      validator.for('admin_code')
        .rule(required())
        .when((data) => data.role === 'admin')

      const result = await validator.validate({ role: 'user' })
      expect(result.success).toBe(true)
    })

    test('validates unless condition is true', async () => {
      const validator = createValidator()
      validator.for('email')
        .rule(required())
        .unless((data) => data.has_email === false)

      const result = await validator.validate({ has_email: false })
      expect(result.success).toBe(true)

      const result2 = await validator.validate({ has_email: true })
      expect(result2.success).toBe(false)
    })
  })

  describe('sometimes validation', () => {
    test('validates only when field is present', async () => {
      const validator = createValidator()
      validator.for('nickname')
        .rules(min(3), max(20))
        .sometimes()

      const result1 = await validator.validate({})
      expect(result1.success).toBe(true)

      const result2 = await validator.validate({ nickname: 'ab' })
      expect(result2.success).toBe(false)

      const result3 = await validator.validate({ nickname: 'johnny' })
      expect(result3.success).toBe(true)
    })
  })

  describe('nullable validation', () => {
    test('allows null values when nullable', async () => {
      const validator = createValidator()
      validator.for('middle_name')
        .rules(min(2))
        .nullable()

      const result = await validator.validate({ middle_name: null })
      expect(result.success).toBe(true)
    })
  })

  describe('validateOrThrow', () => {
    test('returns data on success', async () => {
      const validator = new Validator()
        .field('name', required())

      const data = await validator.validateOrThrow({ name: 'John' })
      expect(data.name).toBe('John')
    })

    test('throws ValidationException on failure', async () => {
      const validator = new Validator()
        .field('name', required())

      await expect(validator.validateOrThrow({})).rejects.toThrow(ValidationException)
    })
  })

  describe('Validator.make', () => {
    test('creates validator from rules object', async () => {
      const validator = Validator.make({
        name: [required(), min(2)],
        email: [required(), email()],
      })

      const result = await validator.validate({ name: 'Jo', email: 'invalid' })
      expect(result.success).toBe(false)
      expect(result.errors?.email).toBeDefined()
    })
  })

  describe('quickValidate', () => {
    test('validates data quickly', async () => {
      const result = await quickValidate(
        { name: 'John', email: 'john@example.com' },
        { name: [required()], email: [required(), email()] }
      )
      expect(result.success).toBe(true)
    })
  })

  describe('quickValidateOrThrow', () => {
    test('returns data on success', async () => {
      const data = await quickValidateOrThrow(
        { name: 'John' },
        { name: [required()] }
      )
      expect(data.name).toBe('John')
    })

    test('throws on failure', async () => {
      await expect(
        quickValidateOrThrow({}, { name: [required()] })
      ).rejects.toThrow(ValidationException)
    })
  })
})

describe('FieldValidator', () => {
  test('bail stops on first error', async () => {
    const field = new FieldValidator('password')
      .rules(required(), min(8), regex(/[A-Z]/))
      .bail()

    const errors = await field.validate('', {})
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain('required')
  })

  test('continueOnError collects all errors', async () => {
    const field = new FieldValidator('password')
      .rules(required(), min(8), regex(/[A-Z]/))
      .continueOnError()

    const errors = await field.validate('ab', {})
    expect(errors.length).toBe(2)
  })

  test('chained configuration', async () => {
    const field = new FieldValidator('code')
      .rule(required())
      .rule(min(6))
      .rule(max(10))
      .when((data) => data.type === 'promo')
      .bail()

    const errors1 = await field.validate('', { type: 'regular' })
    expect(errors1.length).toBe(0)

    const errors2 = await field.validate('', { type: 'promo' })
    expect(errors2.length).toBe(1)
  })
})
