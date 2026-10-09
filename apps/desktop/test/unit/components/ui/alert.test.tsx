import { createRef } from "react"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

describe("Alert", () => {
  it("is an alert holding its title and description", () => {
    const ref = createRef<HTMLDivElement>()
    render(
      <Alert ref={ref} variant="destructive">
        <AlertTitle>Chat issue</AlertTitle>
        <AlertDescription>The backend stopped.</AlertDescription>
      </Alert>
    )

    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("Chat issueThe backend stopped.")
    expect(ref.current).toBe(alert)
  })

  it("lets the caller choose a polite status role instead", () => {
    render(
      <Alert aria-live="polite" role="status">
        <AlertDescription>Saved.</AlertDescription>
      </Alert>
    )

    expect(screen.queryByRole("alert")).toBeNull()
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite")
  })
})
