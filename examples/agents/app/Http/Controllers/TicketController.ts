import { Controller } from '@guren/core'

import { Ticket } from '../../Models/Ticket'
import { presentTicket, type TicketRow } from '../../Services/tickets'
import {
  CreateTicketSchema,
  ListTicketsQuerySchema,
  TicketIdParamSchema,
} from '../Validators/TicketValidator'

export default class TicketController extends Controller {
  async index(): Promise<Response> {
    const { status } = this.validateQuery(ListTicketsQuerySchema)
    const query = status ? Ticket.where('status', status) : Ticket.newQuery()
    const rows = (await query.orderBy('id', 'asc').get()) as TicketRow[]

    return this.json({ tickets: rows.map(presentTicket) })
  }

  async store(): Promise<Response> {
    const { title, createdAt } = await this.validateBody(CreateTicketSchema)
    const at = createdAt ? new Date(createdAt) : new Date()
    const ticket = (await Ticket.create({
      title,
      status: 'open',
      createdAt: at,
      updatedAt: at,
    })) as TicketRow

    return this.json({ ticket: presentTicket(ticket) }, { status: 201 })
  }

  async close(): Promise<Response> {
    const { id } = this.validateParams(TicketIdParamSchema)
    await Ticket.findOrFail(id)
    const updated = (await Ticket.where('id', id).update({
      status: 'closed',
      updatedAt: new Date(),
    })) as TicketRow

    return this.json({ ticket: presentTicket(updated) })
  }
}
