/**
 * Journey: the Generation pane's Reply ceiling switch persists through
 * `settings.json`.
 */

import { GENERATION_PANE } from "../lib/rendererSteps.mjs"
import { buildSettingsSwitchJourney } from "./settingsSwitchJourney.mjs"

export default buildSettingsSwitchJourney({
  id: "settings-generation-ui",
  title:
    "Switching Reply ceiling off in Settings → Generation writes generation.replyCeiling 0 to settings.json, the switch is still off after a reload, and switching it on restores 2048",
  pane: GENERATION_PANE,
  switchLabel: "Reply ceiling",
  fieldPath: ["generation", "replyCeiling"],
  onValue: 2048,
  offValue: 0
})
