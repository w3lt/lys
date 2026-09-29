import type { DatabaseSync } from "node:sqlite";
import type { AgentCreationOptions, AgentManager } from "../../../modules/agent/agentManager";
import type { Agent } from "../../../modules/agent/models";

export default class AgentService implements AgentManager {
  readonly #database: DatabaseSync  

  createAgent(options: AgentCreationOptions): Agent {
    throw new Error("Method not implemented.");
  }
  getAgent(code: string): Agent {
    throw new Error("Method not implemented.");
  }
  updateAgent(options: AgentCreationOptions): Agent {
    throw new Error("Method not implemented.");
  }
  deleteAgent(code: string): void {
    throw new Error("Method not implemented.");
  }
}