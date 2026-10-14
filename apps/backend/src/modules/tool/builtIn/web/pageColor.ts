/** A color as its sRGB channels, 0 to 255, and its alpha, 0 to 1. */
export type SrgbColor = Readonly<{
  red: number
  green: number
  blue: number
  alpha: number
}>

/** Three numbers, such as a color's channels or one row of a matrix. */
type Triple = readonly [number, number, number]

/** A 3 by 3 matrix, by rows. */
type Matrix = readonly [Triple, Triple, Triple]

/** Untrusted texts of one color's components. */
type ColorComponentTexts = Readonly<{
  /** Name of the color space, such as `rgb` or `display-p3`. */
  space: string
  /** The three channels, then the alpha. */
  components: readonly string[]
}>

/** One color's components, parsed. */
type ColorComponents = Readonly<{
  /** The three channels in the color's own space. */
  channels: Triple
  /** Opacity from 0 to 1. */
  alpha: number
}>

/** How the channels of one color syntax become CIE XYZ, relative to D65. */
type ColorSpace = Readonly<{
  /** Value of each channel written as 100%. */
  percentScales: Triple
  /** Converts the channels, `none` taken as 0, to XYZ D65. */
  convertToXyz: (channels: Triple) => Triple
}>

/** Finds a color function's name and what its parentheses hold. */
const COLOR_FUNCTION_PATTERN = /^([a-z-]+)\((.*)\)$/

/** Finds the separators between a color function's components. */
const COMPONENT_SEPARATOR_PATTERN = /[\s,]+/

/** Finds a number, optionally a percentage or an angle in degrees. */
const COMPONENT_PATTERN = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|deg)?$/i

/** Most value of an sRGB channel. */
const MAXIMUM_CHANNEL = 255

/** CIE constant ε of the Lab conversion: 216 / 24389. */
const LAB_EPSILON = 216 / 24_389

/** CIE constant κ of the Lab conversion: 24389 / 27. */
const LAB_KAPPA = 24_389 / 27

/** White point D50 in XYZ, the reference white of CSS Lab and LCH. */
const D50_WHITE: Triple = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585]

/** Bradford adaptation from D50 to D65. */
const D50_TO_D65: Matrix = [
  [0.955473421488075, -0.02309845494876471, 0.06325924320057072],
  [-0.0283697093338637, 1.0099953980813041, 0.021041441191917323],
  [0.012314014864481998, -0.020507649298898964, 1.330365926242124]
]

/** Linear sRGB to XYZ D65. */
const LINEAR_SRGB_TO_XYZ: Matrix = [
  [0.41239079926595934, 0.357584339383878, 0.1804807884018343],
  [0.21263900587151027, 0.715168678767756, 0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607]
]

/** XYZ D65 to linear sRGB. */
const XYZ_TO_LINEAR_SRGB: Matrix = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786]
]

/** Linear Display P3 to XYZ D65. */
const LINEAR_DISPLAY_P3_TO_XYZ: Matrix = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0, 0.04511338185890264, 1.043944368900976]
]

/** OKLab to the cube roots of LMS. */
const OKLAB_TO_LMS_ROOTS: Matrix = [
  [1, 0.3963377773761749, 0.2158037573099136],
  [1, -0.1055613458156586, -0.0638541728258133],
  [1, -0.0894841775298119, -1.2914855480194092]
]

/** LMS to XYZ D65, for OKLab. */
const LMS_TO_XYZ: Matrix = [
  [1.2268798758459243, -0.5578149944602171, 0.2813910456659647],
  [-0.0405757452148008, 1.112286803280317, -0.0717110580655164],
  [-0.0763729366746601, -0.4214933324022432, 1.5869240198367816]
]

/**
 * Multiplies a matrix by a vector.
 *
 * @param matrix - Matrix, by rows.
 * @param vector - Column vector.
 * @returns The product.
 */
function multiplyMatrix(matrix: Matrix, vector: Triple): Triple {
  const [first, second, third] = matrix.map(
    (row) => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]
  )
  return [first ?? 0, second ?? 0, third ?? 0]
}

/**
 * Removes the sRGB transfer function from one channel.
 *
 * @param value - Gamma-encoded channel, 0 to 1 within the gamut.
 * @returns The linear channel; the curve is mirrored for negative values.
 */
function linearizeSrgbChannel(value: number): number {
  const magnitude = Math.abs(value)
  const linear =
    magnitude <= 0.04045
      ? magnitude / 12.92
      : ((magnitude + 0.055) / 1.055) ** 2.4
  return Math.sign(value) * linear
}

/**
 * Applies the sRGB transfer function to one channel.
 *
 * @param value - Linear channel.
 * @returns The gamma-encoded channel; the curve is mirrored for negative
 * values.
 */
function encodeSrgbChannel(value: number): number {
  const magnitude = Math.abs(value)
  const encoded =
    magnitude <= 0.0031308
      ? magnitude * 12.92
      : 1.055 * magnitude ** (1 / 2.4) - 0.055
  return Math.sign(value) * encoded
}

/**
 * Converts gamma-encoded RGB channels to linear ones.
 *
 * @param channels - sRGB or Display P3 channels, which share a transfer
 * function.
 * @returns The linear channels.
 */
function linearizeRgb(channels: Triple): Triple {
  return [
    linearizeSrgbChannel(channels[0]),
    linearizeSrgbChannel(channels[1]),
    linearizeSrgbChannel(channels[2])
  ]
}

/**
 * Converts CIE Lab to XYZ D65.
 *
 * @param channels - Lightness from 0 to 100, then a and b.
 * @returns The color in XYZ, adapted from Lab's D50 white to D65.
 */
function convertLabToXyz(channels: Triple): Triple {
  const [lightness, a, b] = channels
  const fy = (lightness + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const x = fx ** 3 > LAB_EPSILON ? fx ** 3 : (116 * fx - 16) / LAB_KAPPA
  const y =
    lightness > LAB_KAPPA * LAB_EPSILON ? fy ** 3 : lightness / LAB_KAPPA
  const z = fz ** 3 > LAB_EPSILON ? fz ** 3 : (116 * fz - 16) / LAB_KAPPA
  return multiplyMatrix(D50_TO_D65, [
    x * D50_WHITE[0],
    y * D50_WHITE[1],
    z * D50_WHITE[2]
  ])
}

/**
 * Converts OKLab to XYZ D65.
 *
 * @param channels - Lightness from 0 to 1, then a and b.
 * @returns The color in XYZ.
 */
function convertOklabToXyz(channels: Triple): Triple {
  const [long, medium, short] = multiplyMatrix(OKLAB_TO_LMS_ROOTS, channels)
  return multiplyMatrix(LMS_TO_XYZ, [long ** 3, medium ** 3, short ** 3])
}

/**
 * Converts polar chroma and hue to the a and b axes.
 *
 * @param channels - Lightness, chroma, and hue in degrees.
 * @returns Lightness, a, and b.
 */
function convertPolarToRectangular(channels: Triple): Triple {
  const [lightness, chroma, hue] = channels
  const radians = (hue * Math.PI) / 180
  return [lightness, chroma * Math.cos(radians), chroma * Math.sin(radians)]
}

/** Channels written from 0 to 255, gamma-encoded, as `rgb()` writes them. */
const SRGB_BYTE_SPACE: ColorSpace = {
  percentScales: [255, 255, 255],
  convertToXyz: (channels) =>
    multiplyMatrix(
      LINEAR_SRGB_TO_XYZ,
      linearizeRgb([
        channels[0] / MAXIMUM_CHANNEL,
        channels[1] / MAXIMUM_CHANNEL,
        channels[2] / MAXIMUM_CHANNEL
      ])
    )
}

/** XYZ relative to D65, which every conversion goes through. */
const XYZ_D65_SPACE: ColorSpace = {
  percentScales: [1, 1, 1],
  convertToXyz: (channels) => channels
}

/** Color spaces Lys converts, by their name in CSS. */
const COLOR_SPACES: ReadonlyMap<string, ColorSpace> = new Map<
  string,
  ColorSpace
>([
  ["rgb", SRGB_BYTE_SPACE],
  ["rgba", SRGB_BYTE_SPACE],
  [
    "srgb",
    {
      percentScales: [1, 1, 1],
      convertToXyz: (channels) =>
        multiplyMatrix(LINEAR_SRGB_TO_XYZ, linearizeRgb(channels))
    }
  ],
  [
    "srgb-linear",
    {
      percentScales: [1, 1, 1],
      convertToXyz: (channels) => multiplyMatrix(LINEAR_SRGB_TO_XYZ, channels)
    }
  ],
  [
    "display-p3",
    {
      percentScales: [1, 1, 1],
      convertToXyz: (channels) =>
        multiplyMatrix(LINEAR_DISPLAY_P3_TO_XYZ, linearizeRgb(channels))
    }
  ],
  ["xyz", XYZ_D65_SPACE],
  ["xyz-d65", XYZ_D65_SPACE],
  [
    "xyz-d50",
    {
      percentScales: [1, 1, 1],
      convertToXyz: (channels) => multiplyMatrix(D50_TO_D65, channels)
    }
  ],
  ["lab", { percentScales: [100, 125, 125], convertToXyz: convertLabToXyz }],
  [
    "lch",
    {
      percentScales: [100, 150, 1],
      convertToXyz: (channels) =>
        convertLabToXyz(convertPolarToRectangular(channels))
    }
  ],
  ["oklab", { percentScales: [1, 0.4, 0.4], convertToXyz: convertOklabToXyz }],
  [
    "oklch",
    {
      percentScales: [1, 0.4, 1],
      convertToXyz: (channels) =>
        convertOklabToXyz(convertPolarToRectangular(channels))
    }
  ]
])

/**
 * Parses one component of a color function.
 *
 * @param text - Untrusted component: a number, a percentage, an angle in
 * degrees, or `none`.
 * @param percentScale - Value written as 100%.
 * @returns The value, 0 for `none`, or undefined for anything else.
 */
function parseColorComponent(
  text: string,
  percentScale: number
): number | undefined {
  if (text === "none") return 0
  const match = COMPONENT_PATTERN.exec(text)
  if (match === null) return undefined
  const value = Number(match[1])
  return match[2] === "%" ? (value / 100) * percentScale : value
}

/**
 * Splits what a color function's parentheses hold.
 *
 * @param name - Function name, such as `rgb` or `color`.
 * @param body - Untrusted text inside the parentheses, with components
 * separated by spaces or commas and an optional `/ alpha`.
 * @returns The color space's name, and its three channel texts followed by
 * the alpha text, `1` when absent; or undefined when there are not three
 * channels and at most one alpha.
 */
function splitColorFunction(
  name: string,
  body: string
): ColorComponentTexts | undefined {
  const [channelText = "", alphaText, extra] = body.split("/")
  const components = channelText
    .trim()
    .split(COMPONENT_SEPARATOR_PATTERN)
    .filter((component) => component !== "")
  const space = name === "color" ? (components.shift() ?? "") : name
  if (alphaText !== undefined) components.push(alphaText.trim())
  else if (components.length === 3) components.push("1")
  if (extra !== undefined || components.length !== 4) return undefined
  return Object.freeze({ space, components })
}

/**
 * Parses the components of one color.
 *
 * @param texts - The three channel texts, then the alpha text.
 * @param percentScales - Value of each channel written as 100%.
 * @returns The channels and the alpha, clamped to 0 to 1; or undefined when
 * a component is not a number, a percentage, an angle, or `none`.
 */
function parseColorComponents(
  texts: readonly string[],
  percentScales: Triple
): ColorComponents | undefined {
  const scales = [...percentScales, 1]
  const values = texts.map((text, index) =>
    parseColorComponent(text, scales[index] ?? 1)
  )
  if (!values.every((value) => value !== undefined)) return undefined
  const [first = 0, second = 0, third = 0, alpha = 1] = values
  const channels: Triple = [first, second, third]
  return Object.freeze({ channels, alpha: Math.min(1, Math.max(0, alpha)) })
}

/**
 * Converts XYZ D65 to sRGB channels, clipped to the gamut.
 *
 * @param xyz - Color in XYZ.
 * @returns Red, green, and blue from 0 to 255.
 */
function convertXyzToSrgbChannels(xyz: Triple): Triple {
  const [red, green, blue] = multiplyMatrix(XYZ_TO_LINEAR_SRGB, xyz).map(
    (channel) =>
      Math.min(1, Math.max(0, encodeSrgbChannel(channel))) * MAXIMUM_CHANNEL
  )
  return [red ?? 0, green ?? 0, blue ?? 0]
}

/**
 * Parses a computed CSS color.
 *
 * @param value - Computed value of `color` or `background-color`, as the
 * browser serializes it.
 * @returns The color in sRGB, clipped to its gamut, with its alpha; or
 * undefined for a syntax Lys does not convert, such as `rec2020`,
 * `a98-rgb`, and `prophoto-rgb` colors, or a malformed value.
 * @remarks Converts `rgb()`, `rgba()`, `lab()`, `lch()`, `oklab()`,
 * `oklch()`, and `color()` in `srgb`, `srgb-linear`, `display-p3`, `xyz`,
 * `xyz-d65`, and `xyz-d50`, which covers the colors Chromium computes for
 * `hsl()`, `hwb()`, named colors, and `color-mix()`.
 */
export function parseCssColor(value: string): SrgbColor | undefined {
  const match = COLOR_FUNCTION_PATTERN.exec(value.trim().toLowerCase())
  if (match === null) return undefined
  const texts = splitColorFunction(match[1] ?? "", match[2] ?? "")
  const colorSpace =
    texts === undefined ? undefined : COLOR_SPACES.get(texts.space)
  if (texts === undefined || colorSpace === undefined) return undefined
  const components = parseColorComponents(
    texts.components,
    colorSpace.percentScales
  )
  if (components === undefined) return undefined
  const [red, green, blue] = convertXyzToSrgbChannels(
    colorSpace.convertToXyz(components.channels)
  )
  return Object.freeze({ red, green, blue, alpha: components.alpha })
}
