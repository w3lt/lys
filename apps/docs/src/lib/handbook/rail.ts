/**
 * The stored contract for the navigation rail's width.
 *
 * Rail width is chrome state shared by three consumers: the inline script that
 * restores it before first paint, the control that changes it, and the
 * stylesheet that reads the resulting attribute. Naming the key and the value
 * once keeps those three in agreement.
 */

/** `localStorage` key holding the reader's rail-width choice. */
export const RAIL_STORAGE_KEY = "lys-handbook-rail"

/**
 * Value of `data-rail` and of the stored key while the rail is collapsed.
 *
 * The expanded rail is the default and is represented by the absence of the
 * attribute, so no value is needed for it.
 */
export const COLLAPSED_RAIL = "collapsed"
