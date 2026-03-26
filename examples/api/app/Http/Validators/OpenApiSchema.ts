import { z } from 'zod'

export const UserResourceSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string().email(),
  createdAt: z.string(),
})

export const TaskOwnerSchema = z.object({
  id: z.number().optional(),
  name: z.string().optional(),
})

export const TaskResourceSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().nullable().optional(),
  completed: z.boolean(),
  notificationArtifactPath: z.string(),
  broadcastChannels: z.object({
    public: z.string(),
    private: z.string(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  owner: TaskOwnerSchema.optional(),
})

export const PaginationMetaSchema = z.object({
  currentPage: z.number(),
  lastPage: z.number(),
  perPage: z.number(),
  total: z.number(),
  from: z.number().nullable(),
  to: z.number().nullable(),
})

export const PaginationLinksSchema = z.object({
  first: z.string().nullable(),
  last: z.string().nullable(),
  prev: z.string().nullable(),
  next: z.string().nullable(),
  pages: z.array(z.object({
    page: z.number(),
    url: z.string().nullable(),
    active: z.boolean(),
  })),
})

export const RegisterResponseSchema = z.object({
  user: UserResourceSchema,
  token: z.string(),
  tokenId: z.string(),
})

export const LoginResponseSchema = RegisterResponseSchema

export const AuthenticatedUserResponseSchema = z.object({
  user: UserResourceSchema,
  tokenAbilities: z.array(z.string()),
})

export const TokenSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  abilities: z.array(z.string()),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  createdAt: z.string(),
})

export const TokenListResponseSchema = z.object({
  tokens: z.array(TokenSummarySchema),
})

export const CreateTokenResponseSchema = z.object({
  token: z.string(),
  tokenId: z.string(),
  name: z.string(),
  abilities: z.array(z.string()),
  expiresAt: z.string().nullable(),
})

export const MessageResponseSchema = z.object({
  message: z.string(),
})

export const TaskListResponseSchema = z.object({
  data: z.array(TaskResourceSchema),
  meta: PaginationMetaSchema,
  links: PaginationLinksSchema,
})

export const TaskDetailResponseSchema = z.object({
  data: TaskResourceSchema,
})
