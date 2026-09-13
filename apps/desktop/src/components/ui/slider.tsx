import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

/**
 * Renders the maintained multi-thumb Base UI slider tree with Lys track
 * styling.
 *
 * @remarks The adapter does not render
 * caller-provided `children`; it owns the `Control`, `Track`, `Indicator`, and
 * generated `Thumb` tree. Array `value` or array `defaultValue` supplies one
 * thumb per entry. Scalar values are accepted by the Base UI type but this
 * adapter falls back to `[min, max]` and renders two thumbs, so the scalar
 * mismatch is accepted pre-existing debt rather than a supported single-thumb
 * contract. A controlled array `value` is parent-owned; an array
 * `defaultValue` is primitive-owned after initialization. `min` and `max`
 * default to `0` and `100`. `thumbAlignment="edge"` is the adapter default but
 * later forwarded props may override it; current consumers pass `center`. Base
 * UI coordinates orientation, keyboard, focus, disabled semantics, and state
 * attributes. A supplied `ref` targets the root's `HTMLDivElement` host.
 * For a single thumb, the caller's accessible name is also forwarded to its
 * input; descriptions and explicit value text are forwarded to every thumb input.
 * @param props - Base UI slider props and optional range defaults.
 * @returns The styled slider root with its adapter-owned control, track,
 * indicator, and generated thumbs.
 */
function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: SliderPrimitive.Root.Props) {
  const _values = Array.isArray(value)
    ? value
    : Array.isArray(defaultValue)
      ? defaultValue
      : [min, max]

  return (
    <SliderPrimitive.Root
      className={cn("data-horizontal:w-full data-vertical:h-full", className)}
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      thumbAlignment="edge"
      {...props}
    >
      <SliderPrimitive.Control className="relative flex w-full touch-none items-center select-none data-disabled:opacity-50 data-vertical:h-full data-vertical:min-h-40 data-vertical:w-auto data-vertical:flex-col">
        <SliderPrimitive.Track
          data-slot="slider-track"
          className="relative grow overflow-hidden rounded-[var(--radius-capsule)] bg-[var(--app-control-track)] select-none data-horizontal:h-[3px] data-horizontal:w-full data-vertical:h-full data-vertical:w-[3px]"
        >
          <SliderPrimitive.Indicator
            data-slot="slider-range"
            className="rounded-[var(--radius-capsule)] bg-[var(--app-action)] select-none data-horizontal:h-full data-vertical:w-full"
          />
        </SliderPrimitive.Track>
        {Array.from({ length: _values.length }, (_, index) => (
          /*
           * The track is a functional capsule; the thumb stays a soft square
           * so the control still reads as part of the Lys geometry.
           */
          <SliderPrimitive.Thumb
            aria-label={_values.length === 1 ? props["aria-label"] : undefined}
            aria-labelledby={
              _values.length === 1 ? props["aria-labelledby"] : undefined
            }
            aria-describedby={props["aria-describedby"]}
            aria-valuetext={props["aria-valuetext"]}
            data-slot="slider-thumb"
            key={index}
            className="relative block size-3.5 shrink-0 rounded-[var(--radius-detail)] border border-[var(--app-action)] bg-[var(--app-control-selected-thumb)] ring-ring/50 transition-[border-color,box-shadow] duration-(--duration-standard) ease-(--ease-standard) select-none after:absolute after:-inset-2 hover:ring-3 focus-visible:ring-3 focus-visible:outline-hidden active:ring-3 disabled:pointer-events-none disabled:opacity-70"
          />
        ))}
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
