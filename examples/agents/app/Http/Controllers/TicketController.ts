import { Controller } from '@guren/core'

import { triageTicket } from '../../Ai/TicketTriage'
import { Ticket } from '../../Models/Ticket'
import { presentTicket, type TicketRow } from '../../Services/tickets'
import {
  ConfirmCategorySchema,
  CreateTicketSchema,
  ListTicketsQuerySchema,
  TicketIdParamSchema,
} from '../Validators/TicketValidator'

export default class TicketController extends Controller {
  async index(): Promise<Response> {
    const { status, triage } = this.validateQuery(ListTicketsQuerySchema)
    let query = Ticket.newQuery()
    if (status) query = query.where('status', status)
    if (triage) query = query.where('triage', triage)
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

  async triage(): Promise<Response> {
    const { id } = this.validateParams(TicketIdParamSchema)
    const ticket = (await Ticket.findOrFail(id)) as TicketRow
    const decision = await triageTicket(this.make('ai'), ticket)
    const updated = (await Ticket.where('id', id).update({ ...decision, updatedAt: new Date() })) as TicketRow

    return this.json({ ticket: presentTicket(updated) })
  }

  async confirmCategory(): Promise<Response> {
    const { id } = this.validateParams(TicketIdParamSchema)
    const { category } = await this.validateBody(ConfirmCategorySchema)
    await Ticket.findOrFail(id)
    const updated = (await Ticket.where('id', id).update({
      category,
      categoryProbability: null,
      triage: 'confirmed',
      updatedAt: new Date(),
    })) as TicketRow

    return this.json({ ticket: presentTicket(updated) })
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
