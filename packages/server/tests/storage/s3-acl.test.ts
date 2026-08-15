import { describe, expect, it } from 'bun:test'
import { assertVisibilitySupported, cannedAcl, putAclFields } from '../../src/storage/drivers/s3-acl'

// These cover the decision the S3 driver makes about `x-amz-acl` rather than
// the AWS calls around it: the SDK is an optional peer that is not installed
// here, and stubbing it would only assert that a stub was called. What can be
// checked without it — and what was wrong for every ACL-less endpoint — is
// which fields end up in the command.
describe('cannedAcl', () => {
  it('maps visibility to the S3 canned ACL names', () => {
    expect(cannedAcl('public')).toBe('public-read')
    expect(cannedAcl('private')).toBe('private')
  })
})

describe('putAclFields', () => {
  it('carries the ACL when the endpoint implements ACLs', () => {
    expect(putAclFields(true, 'public')).toEqual({ ACL: 'public-read' })
    expect(putAclFields(true, 'private')).toEqual({ ACL: 'private' })
  })

  it('omits the field entirely when it does not', () => {
    expect(putAclFields(false, 'public')).toEqual({})
    expect(putAclFields(false, 'private')).toEqual({})
  })

  it('never produces an explicit undefined, which some endpoints reject', () => {
    expect('ACL' in putAclFields(false, 'public')).toBe(false)
  })
})

describe('assertVisibilitySupported', () => {
  it('allows anything while ACLs are available', () => {
    expect(() => assertVisibilitySupported(true, 'private', 'public', 'put')).not.toThrow()
    expect(() => assertVisibilitySupported(true, 'public', 'private', 'setVisibility')).not.toThrow()
  })

  it('allows a request that matches the disk visibility, or none at all', () => {
    expect(() => assertVisibilitySupported(false, 'public', 'public', 'put')).not.toThrow()
    expect(() => assertVisibilitySupported(false, 'private', 'private', 'put')).not.toThrow()
    expect(() => assertVisibilitySupported(false, 'public', undefined, 'put')).not.toThrow()
  })

  it('refuses a per-object visibility an ACL-less endpoint cannot honour', () => {
    expect(() => assertVisibilitySupported(false, 'public', 'private', 'put')).toThrow(
      /S3Driver\.put:.*cannot make an object private on a public disk/,
    )
    expect(() => assertVisibilitySupported(false, 'private', 'public', 'setVisibility')).toThrow(
      /S3Driver\.setVisibility:/,
    )
  })

  it('names the option that fixes it', () => {
    expect(() => assertVisibilitySupported(false, 'public', 'private', 'put')).toThrow(/"visibility" option/)
  })
})
