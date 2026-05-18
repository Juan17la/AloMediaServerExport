import type { ColorAdjustments } from "../constants/colorAdjustments.js"
import { DEFAULT_COLOR_ADJUSTMENTS } from "../constants/colorAdjustments.js"

export function applyBrightnessCurve(v: number): number {
  return Math.sign(v) * v * v
}

export function applyContrastCurve(v: number): number {
  return Math.sign(v) * Math.sqrt(Math.abs(v))
}

export function applySaturationCurve(v: number): number {
  return v * v
}

export function applyGammaCurve(v: number): number {
  return v
}

export function applyShadowCurve(v: number): number {
  return v * v * v
}

export function applyDefinitionCurve(v: number): number {
  return v
}

export function buildEqFilter(adj: ColorAdjustments): string | null {
  const d = DEFAULT_COLOR_ADJUSTMENTS
  const exposure = adj.exposure ?? d.exposure
  const rawBrightness = adj.brightness ?? d.brightness
  const mappedBrightness = applyBrightnessCurve(rawBrightness)
  // Align with CSS preview: CSS brightness is multiplicative (1=neutral).
  // Convert to FFmpeg eq=brightness additive scale (-1..1, 0=neutral).
  const cssBrightness = (mappedBrightness + 1) * Math.pow(2, exposure)
  const combinedBrightness = Math.max(-1, Math.min(1, cssBrightness - 1))

  const parts: string[] = []

  if (rawBrightness !== d.brightness || exposure !== d.exposure) {
    parts.push(`brightness=${combinedBrightness.toFixed(4)}`)
  }

  const rawContrast = adj.contrast ?? d.contrast
  if (rawContrast !== d.contrast) {
    const mappedContrast = applyContrastCurve(rawContrast)
    // Align with CSS preview: CSS contrast is multiplicative (1=neutral).
    // FFmpeg eq=contrast is also multiplicative (1=neutral).
    const ffmpegContrast = mappedContrast + 1
    parts.push(`contrast=${ffmpegContrast.toFixed(4)}`)
  }

  const rawSaturation = adj.saturation ?? d.saturation
  if (rawSaturation !== d.saturation) {
    const mappedSaturation = applySaturationCurve(rawSaturation)
    parts.push(`saturation=${mappedSaturation.toFixed(4)}`)
  }

  const rawGamma = adj.gamma ?? d.gamma
  if (rawGamma !== d.gamma) {
    const mappedGamma = applyGammaCurve(rawGamma)
    parts.push(`gamma=${mappedGamma.toFixed(4)}`)
  }

  return parts.length > 0 ? `eq=${parts.join(":")}` : null
}

export function buildShadowFilter(adj: ColorAdjustments): string | null {
  const rawShadow = adj.shadow ?? DEFAULT_COLOR_ADJUSTMENTS.shadow ?? 0
  if (rawShadow === 0) return null
  const mapped = applyShadowCurve(rawShadow)
  const amount = mapped * 0.15
  if (amount > 0) {
    return `curves=all='0/${amount.toFixed(4)} 1/1'`
  } else {
    const crush = Math.abs(amount)
    return `curves=all='0/0 ${crush.toFixed(4)}/0 1/1'`
  }
}

export function buildDefinitionFilter(adj: ColorAdjustments): string | null {
  const rawDef = adj.definition ?? DEFAULT_COLOR_ADJUSTMENTS.definition ?? 0
  if (rawDef === 0) return null
  const lumaAmount = applyDefinitionCurve(rawDef) * 1.5
  return `unsharp=luma_msize_x=5:luma_msize_y=5:luma_amount=${lumaAmount.toFixed(4)}`
}