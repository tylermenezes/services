import { ItineraryItem } from "./ItineraryItem"
import { Plan } from "./Plan"

export interface Trip {
  id: string
  timeZoneShift: number
  tripType: 'one-way'
  surveys: any[]
  itinerary: ItineraryItem[]
  plans: Plan[]
}