import { defineModel } from '@guren/orm'

import { users } from '../../db/schema'

export class User extends defineModel(users, { fillable: ['name', 'email'] }) {}
