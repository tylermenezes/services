import { ItineraryItem } from "./ItineraryItem"
import { Plan } from "./Plan"

export interface TimeshifterTripCreateInputItineraryItem {
  departureAirport: string
  departureTime: string
  arrivalAirport: string
  arrivalTime: string
}
export interface TimeshifterTripCreateItineraryItem {
  departureAirport: string
  departureTime: string
  arrivalAirport: string
  arrivalTime: string
  flightCode: string
  flightId: string
}

export interface TimeshifterTripCreateRequest {
  itinerary: TimeshifterTripCreateInputItineraryItem[][]
  preadaptationDays: number
}
export interface TimeshifterCreateTripResponse {
  id: string
  tripType: string
  itinerary: ItineraryItem[][]
  plans: Plan[][]
}