import { describe } from "vitest"
import { openSqliteDelegationRecords } from "../../../support/delegationDatabase"
import { registerJobReaderContractSuite } from "../../../support/delegationRecordsContract"

describe("SqliteJobReader", () => {
  registerJobReaderContractSuite(() => openSqliteDelegationRecords())
})
