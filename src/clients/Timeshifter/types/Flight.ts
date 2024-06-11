export interface TimeshifterFlight {
  id: string
  flightId: string
  flightCode: string
  arrivalCity: string
  arrivalAirport: string
  arrivalTime: string
  arrivalTimeUtc: string
  departureCity: string
  departureAirport: string
  departureTime: string
  departureTimeUtc: string
  preAdaptationDays: number
}