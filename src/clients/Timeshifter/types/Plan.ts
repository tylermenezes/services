import { TimeshifterFlight } from "./Flight"

export interface Plan {
  type: 'prioritize-light' | 'see-light' | 'avoid-light' | 'use-caffeine' | 'avoid-caffeine' | 'melatonin-sleep' | 'airplane'
  start: string
  end: string
  flightIndex?: number
  flight?: TimeshifterFlight
}