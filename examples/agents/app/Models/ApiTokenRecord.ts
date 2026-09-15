import { defineModel } from '@guren/core'

import { apiTokens } from '../../db/schema'

/**
 * Named for the table rather than the framework's `ApiToken` interface, which
 * this app also imports: the store converts between the two.
 */
export class ApiTokenRecord extends defineModel(apiTokens, {
  // Nothing here is ever written from request input; the store uses force*.
  fillable: [],
  hidden: ['hashedToken'],
}) {}
