import { createRef } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { NativeSelect } from "@/components/ui/native-select"

describe("NativeSelect", () => {
  it("renders a native select that forwards its attributes, options, and ref", () => {
    const ref = createRef<HTMLSelectElement>()
    render(
      <NativeSelect
        aria-invalid
        aria-label="Time zone"
        onChange={vi.fn()}
        ref={ref}
        value="UTC"
      >
        <option value="UTC">UTC</option>
        <option value="Asia/Tokyo">Asia/Tokyo</option>
      </NativeSelect>
    )

    const select = screen.getByRole("combobox", { name: "Time zone" })
    expect(select.tagName).toBe("SELECT")
    expect(select).toHaveValue("UTC")
    expect(select).toBeInvalid()
    expect(ref.current).toBe(select)
  })

  it("reports the chosen option", async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <NativeSelect aria-label="Time zone" onChange={onChange}>
        <option value="UTC">UTC</option>
        <option value="Asia/Tokyo">Asia/Tokyo</option>
      </NativeSelect>
    )

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Time zone" }),
      "Asia/Tokyo"
    )

    expect(onChange).toHaveBeenCalledOnce()
    expect(screen.getByRole("combobox", { name: "Time zone" })).toHaveValue(
      "Asia/Tokyo"
    )
  })

  it("offers no choice while disabled", async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(
      <NativeSelect
        aria-label="Time zone"
        defaultValue="UTC"
        disabled
        onChange={onChange}
      >
        <option value="UTC">UTC</option>
        <option value="Asia/Tokyo">Asia/Tokyo</option>
      </NativeSelect>
    )

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Time zone" }),
      "Asia/Tokyo"
    )

    expect(screen.getByRole("combobox", { name: "Time zone" })).toHaveValue(
      "UTC"
    )
    expect(onChange).not.toHaveBeenCalled()
  })
})
