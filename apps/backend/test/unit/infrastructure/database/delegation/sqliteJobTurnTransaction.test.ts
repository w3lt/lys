import { describe } from "vitest"
import { openSqliteConversationRecords } from "../../../support/conversationDatabase"
import { registerJobTurnTransactionContractSuite } from "../../../support/jobTurnTransactionContract"

describe("SqliteJobTurnTransaction", () => {
  registerJobTurnTransactionContractSuite(() => openSqliteConversationRecords())
})
