import { vi } from "vitest"

/**
 * Creates an image element that reports its source as already decoded, the
 * state the platform reports for a cached image.
 *
 * @returns An image element whose `complete` is true and whose natural width
 * is not zero.
 * @remarks Called with `new` in place of the `Image` constructor; returning
 * the element makes `new` produce it.
 */
function createDecodedImage(): HTMLImageElement {
  const image = document.createElement("img")
  Object.defineProperty(image, "complete", { value: true })
  Object.defineProperty(image, "naturalWidth", { value: 1 })
  return image
}

/**
 * Makes every image a component probes with `new Image()` report as loaded.
 *
 * @remarks jsdom never loads an image, so a component that shows its image
 * only once the image has loaded, such as Base UI's avatar image, would
 * otherwise never render it, and no case could observe how the rendered image
 * is exposed. Only `Image` probes change; `<img>` elements in the document
 * stay jsdom's own. Vitest removes the substitution after the case
 * (`unstubGlobals`).
 */
export function startDecodedImageHost(): void {
  vi.stubGlobal("Image", createDecodedImage)
}
