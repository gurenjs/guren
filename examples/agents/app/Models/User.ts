import { defineModel } from '@guren/core'

import { users } from '../../db/schema'

export class User extends defineModel(users, { fillable: ['name', 'email'] }) {}
