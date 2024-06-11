import fetch from "cross-fetch";
import debug from 'debug';
import {
  TimeshifterCreateTripResponse,
  TimeshifterSignInRequest,
  TimeshifterSignInResponse,
  TimeshifterTripCreateRequest,
  TimeshifterTripValidateRequest,
  TimeshifterTripValidateResponse,
  TimeshifterUser,
} from './types';

const DEBUG = debug('services:clients:timeshifter');

export class Timeshifter {
  email: string;
  password: string;
  token: string | undefined;

  constructor(email: string, password: string, token?: string) {
    this.email = email;
    this.password = password;
    if(token) this.token = token;
  }

  static flightId(
    airline: string,
    flightNumber: string,
    departureAirport: string,
    departureDateUtc: string,
    departureTimeUtc: string,
  ): string {
    return [
      airline,
      flightNumber,
      departureAirport,
      departureDateUtc,
      departureTimeUtc,
    ].join(':');
  }

  async login(): Promise<void> {
    const resp = await this.request<TimeshifterSignInRequest, TimeshifterSignInResponse>(
      '/signin',
      'POST',
      {
        email: this.email,
        pass: this.password,
        devicePlatform: 'ios',
        deviceName: this.email,
      },
      false
    );
    DEBUG(`TIMESHIFTER_TOKEN=${resp.token}`);
    this.token = resp.token;
  }

  async validateTrip(trip: TimeshifterTripValidateRequest): Promise<TimeshifterTripValidateResponse> {
    return this.authenticatedRequest<TimeshifterTripValidateRequest, TimeshifterTripValidateResponse>(
      '/trip/validate',
      'POST',
      trip,
    );
  }

  async createTrip(trip: TimeshifterTripCreateRequest): Promise<TimeshifterCreateTripResponse> {
    return this.authenticatedRequest<TimeshifterTripCreateRequest, TimeshifterCreateTripResponse>(
      '/trip',
      'POST',
      trip,
    );
  }

  async user(): Promise<TimeshifterUser> {
    return this.authenticatedRequest<undefined, TimeshifterUser>(
      '/user',
      'GET',
    );
  }

  async authenticatedRequest<T = undefined, U = object>(
    endpoint: string,
    method: string,
    body?: T,
  ): Promise<U> {
    if (!this.token) await this.login();
    try {
      return await this.request(endpoint, method, body, true);
    } catch (ex) {
      await this.login();
      return await this.request(endpoint, method, body, true);
    }
  }

  async request<T = undefined, U = object>(
    endpoint: string,
    method: string,
    body?: T,
    withAuthorization = true
  ): Promise<U> {
    if (withAuthorization && !this.token) throw new Error('Call login() first.');
    return await fetch(
      `https://api.timeshifter.com/v1${endpoint}`,
      {
        method,
        headers: {
          ...(withAuthorization ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(body ? { 'Content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }
    ).then(r => r.json());
  }
}