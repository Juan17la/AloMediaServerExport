import { DEFAULT_SPEED } from "../constants/speed.js"

const SPEED_EPSILON = 0.001
const ATEMPO_MIN = 0.5
const ATEMPO_MAX = 2.0

export function buildVideoSpeedFilter(speed: number): string | null {
  if (Math.abs(speed - DEFAULT_SPEED) < SPEED_EPSILON) return null
  return `setpts=${(1 / speed).toFixed(6)}*PTS`
}

export function buildAudioSpeedFilter(speed: number): string | null {
  if (Math.abs(speed - DEFAULT_SPEED) < SPEED_EPSILON) return null

  if (Math.abs(speed - ATEMPO_MIN) < SPEED_EPSILON || Math.abs(speed - ATEMPO_MAX) < SPEED_EPSILON) {
    return `atempo=${speed.toFixed(6)}`
  }

  let remaining = speed
  const filters: string[] = []

  while (remaining > ATEMPO_MAX + SPEED_EPSILON) {
    filters.push("atempo=2.0")
    remaining /= ATEMPO_MAX
  }

  while (remaining < ATEMPO_MIN - SPEED_EPSILON) {
    filters.push("atempo=0.5")
    remaining /= ATEMPO_MIN
  }

  if (Math.abs(remaining - DEFAULT_SPEED) < SPEED_EPSILON && filters.length > 0) {
    return filters.join(",")
  }

  if (Math.abs(remaining - ATEMPO_MIN) < SPEED_EPSILON) remaining = ATEMPO_MIN
  if (Math.abs(remaining - ATEMPO_MAX) < SPEED_EPSILON) remaining = ATEMPO_MAX

  filters.push(`atempo=${remaining.toFixed(6)}`)
  return filters.join(",")
}