import { describe } from "vitest"
import { openSqliteDelegationRecords } from "../../../support/delegationDatabase"
import { registerJobActivityReaderContractSuite } from "../../../support/delegationRecordsContract"

describe("SqliteJobActivityReader", () => {
  registerJobActivityReaderContractSuite(() => openSqliteDelegationRecords())
})
