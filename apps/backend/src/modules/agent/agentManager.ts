import * as z from "zod"
import type { Agent } from "./models"

const agentCodeShema = z.string().min(1).max(64)
const agentNameSchema = z.string().min(1).max(64)
const agentBioSchema = z.string().min(1).max(128)
const agentSystemPromptSchema = z.string().min(1)

export const agentCreationOptionsSchema = z
  .strictObject({
    code: agentCodeShema,
    name: agentNameSchema,
    bio: agentBioSchema,
    systemPrompt: agentSystemPromptSchema
  })
  .readonly()

export type AgentCreationOptions = z.infer<typeof agentCreationOptionsSchema>

export const agentUpdateOptionsSchema = z.strictObject({
  code: agentCodeShema,
  name: agentNameSchema.optional(),
  bio: agentBioSchema.optional(),
  systemPrompt: agentSystemPromptSchema.optional()
})

export type AgentUpdateOptions = z.infer<typeof agentUpdateOptionsSchema>

export interface AgentManager {
  createAgent(options: AgentCreationOptions): Agent
  getAgent(code: string): Agent
  updateAgent(options: AgentCreationOptions): Agent
  deleteAgent(code: string): void
}