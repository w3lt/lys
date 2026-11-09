/**
 * Journey: the Runtime pane's "Start it when Lys opens" switch persists
 * through `settings.json`.
 */

import { RUNTIME_PANE } from "../lib/rendererSteps.mjs"
import { buildSettingsSwitchJourney } from "./settingsSwitchJourney.mjs"

export default buildSettingsSwitchJourney({
  id: "settings-autostart-ui",
  title:
    'Switching "Start it when Lys opens" off in Settings → Runtime writes runtime.autoStartBackend false to settings.json, the switch is still off after a reload, and switching it on restores true',
  pane: RUNTIME_PANE,
  switchLabel: "Start it when Lys opens",
  fieldPath: ["runtime", "autoStartBackend"],
  onValue: true,
  offValue: false
})
