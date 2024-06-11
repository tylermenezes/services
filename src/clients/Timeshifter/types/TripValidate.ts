export interface TimeshifterTripValidateItineraryItem {
  departureAirport: string
  departureTime: string
  arrivalAirport: string
  arrivalTime: string
}
export interface TimeshifterTripValidateRequest {
  itinerary: TimeshifterTripValidateItineraryItem[][]
}
export interface TimeshifterTripValidateResponse {
  maxPreadaptationDays: number
}