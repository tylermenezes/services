export interface TimeshifterSignInRequest {
  email: string
  pass: string
  devicePlatform: string
  deviceName: string
}
export interface TimeshifterSignInResponse {
  token: string
}
