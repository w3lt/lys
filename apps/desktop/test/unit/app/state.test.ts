import { describe, expect, it } from "vitest"
import { appReducer, createInitialState } from "@/app/state"

describe("createInitialState", () => {
  it("starts with the chat transcript scrolled to the bottom", () => {
    expect(createInitialState(0).atBottom).toBe(true)
  })
})

describe("appReducer", () => {
  it.each([false, true])(
    "records a reported scroll position at the bottom: %s",
    (atBottom) => {
      const state = { ...createInitialState(0), atBottom: !atBottom }

      expect(
        appReducer(state, { type: "scrollPositionChanged", atBottom })
      ).toEqual({ ...state, atBottom })
    }
  )

  it("leaves the previous state unchanged when recording a scroll position", () => {
    const state = createInitialState(0)

    appReducer(state, { type: "scrollPositionChanged", atBottom: false })

    expect(state.atBottom).toBe(true)
  })
})
