import { describe } from "vitest"
import { openSqliteDelegationRecords } from "../../../support/delegationDatabase"
import { registerJobReportWriterContractSuite } from "../../../support/delegationRecordsContract"

describe("SqliteJobReportWriter", () => {
  registerJobReportWriterContractSuite(() => openSqliteDelegationRecords())
})
