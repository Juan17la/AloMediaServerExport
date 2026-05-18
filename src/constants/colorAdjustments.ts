export interface ColorAdjustments {
  brightness: number
  contrast: number
  saturation: number
  gamma: number
  exposure: number
  shadow?: number
  definition?: number
}

export const DEFAULT_COLOR_ADJUSTMENTS: ColorAdjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 1,
  gamma: 1,
  exposure: 0,
  shadow: 0,
  definition: 0,
}