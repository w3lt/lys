/**
 * Journey: the backend answers its health route, owns the fixed port, and
 * lists a loaded model from the connected provider.
 */

import { sendJsonRequest } from "../lib/httpProbe.mjs"
import { rejectUnless } from "../lib/journey.mjs"
import {
  listListeningPids,
  readProcessGroupId
} from "../lib/processControl.mjs"
import { BACKEND_PORT } from "../lib/repository.mjs"
import { VERIFICATION_MODEL_NAME } from "../lib/verificationProvider.mjs"
import { waitForCondition } from "../lib/waiting.mjs"

/**
 * Waits until the backend reports its provider connected, asking it to
 * connect once if it is not.
 *
 * @param {string} backendUrl - The backend origin.
 * @returns {Promise<unknown>} The runtime status body.
 * @throws If the runtime is not connected within 30 seconds.
 */
async function waitForConnectedRuntime(backendUrl) {
  const first = await sendJsonRequest(`${backendUrl}/api/v1/llm/runtime`)
  if (first.body?.status !== "connected") {
    await sendJsonRequest(`${backendUrl}/api/v1/llm/runtime/connect`, {
      method: "POST",
      json: {}
    })
  }
  return waitForCondition({
    description: "the LLM runtime to report connected",
    timeoutMs: 30_000,
    check: async () => {
      const exchange = await sendJsonRequest(`${backendUrl}/api/v1/llm/runtime`)
      return exchange.body?.status === "connected"
        ? exchange.body
        : exchange.body
    }
  }).then((body) => {
    rejectUnless(
      body?.status === "connected",
      "The runtime must be connected.",
      body
    )
    return body
  })
}

export default Object.freeze({
  id: "backend-health",
  feature: "backend-lifecycle",
  title:
    "The backend answers GET /api/v1/heath, its process group owns port 12345, its provider is connected, and the verification model is listed as loaded",
  needsRenderer: false,
  needsNative: false,
  async run(steps, context) {
    await steps.step(
      "GET /api/v1/heath answers 200 {ok: true}",
      async (evidence) => {
        const exchange = await sendJsonRequest(
          `${context.backendUrl}/api/v1/heath`
        )
        evidence.saveJson("health.json", exchange)
        rejectUnless(
          exchange.status === 200 && exchange.body?.ok === true,
          "The health route must answer 200 with {ok: true}.",
          exchange
        )
        return exchange.body
      }
    )
    await steps.step(
      "the host's backend process group owns port 12345",
      async (evidence) => {
        const status = await sendJsonRequest(`${context.hostUrl}/status`)
        const listeners = listListeningPids(BACKEND_PORT)
        const groups = listeners.map((pid) => ({
          pid,
          group: readProcessGroupId(pid)
        }))
        evidence.saveJson("port-owner.json", {
          hostStatus: status.body,
          groups
        })
        const backendPid = status.body?.backend?.pid
        rejectUnless(
          status.body?.backend?.running === true,
          "The host must report the backend running.",
          status.body
        )
        rejectUnless(
          groups.length > 0,
          "Something must listen on port 12345.",
          groups
        )
        rejectUnless(
          groups.every((entry) => entry.group === backendPid),
          "Every listener on 12345 must belong to the backend's process group.",
          { backendPid, groups }
        )
        return { backendPid, listeners }
      }
    )
    await steps.step("the provider is connected", async (evidence) => {
      const runtime = await waitForConnectedRuntime(context.backendUrl)
      evidence.saveJson("runtime.json", runtime)
      return runtime
    })
    await steps.step(
      "the verification model is listed as loaded",
      async (evidence) => {
        const list = await sendJsonRequest(
          `${context.backendUrl}/api/v1/llm/list`
        )
        evidence.saveJson("llm-list.json", list.body)
        const model = list.body?.llms?.find(
          (llm) => llm.modelKey === VERIFICATION_MODEL_NAME
        )
        rejectUnless(
          model !== undefined,
          `The model list must include ${VERIFICATION_MODEL_NAME}.`,
          list.body
        )
        rejectUnless(
          model.loaded === true,
          "The verification model must be listed as loaded.",
          model
        )
        return {
          modelKey: model.modelKey,
          maxContextLength: model.maxContextLength
        }
      }
    )
  }
})
