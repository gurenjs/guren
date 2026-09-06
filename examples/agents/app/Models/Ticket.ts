import { defineModel } from '@guren/orm'

import { tickets } from '../../db/schema'

// Timestamps are fillable because `POST /tickets` backdates them on purpose:
// it is how the demo produces a ticket old enough for the triager to notice.
export class Ticket extends defineModel(tickets, {
  fillable: ['title', 'status', 'createdAt', 'updatedAt'],
}) {}
