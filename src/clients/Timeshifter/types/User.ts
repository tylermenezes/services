import { Trip } from "./Trip"

export interface TimeshifterUserRequest {
  tripsActiveAfter?: string
}

export interface TimeshifterUser {
  id: string
  name: string
  email: string
  age: number
  gender: string
  chronotype: string
  useCaffeine: boolean
  useMelatonin: boolean
  usePreadaptation: boolean
  sleepingTime: string
  sleepingHours: number
  deleted: string | null
  created: string
  emails: { email: string, isPrimary: boolean, verified: string | null }[]
  subscriptionExpireDate: string | null
  creditAmount: number
  hasSubscription: boolean
  trips: Trip[]
}