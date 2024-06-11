export interface ItineraryItem {
  id: string
  flightId: string
  flightCode: string
  arrivalAirport: string
  arrivalTime: string
  arrivalTimeUtc: string
  departureAirport: string
  departureTime: string
  departureTimeUtc: string
  preAdaptationDays: number
}