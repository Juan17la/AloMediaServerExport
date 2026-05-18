import type { RenderPlan } from "../types.js"

export interface SegmentInfo {
  index: number
  startTimeS: number
  endTimeS: number
  durationS: number
  hasTransition: boolean
  commandArgs: string[]
}

export function splitIntoSegments(plan: RenderPlan): SegmentInfo[] {
  const { transitions, projectDuration } = plan

  if (transitions.length === 0 || projectDuration <= 0) {
    return [{
      index: 0,
      startTimeS: 0,
      endTimeS: projectDuration,
      durationS: projectDuration,
      hasTransition: false,
      commandArgs: [],
    }]
  }

  const boundaries = new Set<number>()
  boundaries.add(0)
  boundaries.add(projectDuration)

  for (const t of transitions) {
    boundaries.add(t.startTimeS)
    boundaries.add(t.endTimeS)
  }

  const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b)

  const transitionTimes = new Set<number>()
  for (const t of transitions) {
    transitionTimes.add(t.startTimeS)
    transitionTimes.add(t.endTimeS)
  }

  const segments: SegmentInfo[] = []

  for (let i = 0; i < sortedBoundaries.length - 1; i++) {
    const startTime = sortedBoundaries[i]
    const endTime = sortedBoundaries[i + 1]
    if (endTime - startTime < 0.001) continue

    const hasTransition =
      transitionTimes.has(startTime) || transitionTimes.has(endTime)

    segments.push({
      index: i,
      startTimeS: startTime,
      endTimeS: endTime,
      durationS: endTime - startTime,
      hasTransition,
      commandArgs: [],
    })
  }

  return segments
}