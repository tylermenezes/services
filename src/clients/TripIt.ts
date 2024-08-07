import { DateTime } from "luxon";
import { OAuth } from "oauth";

// Adapted from https://github.com/mbmccormick/tripit-node/
export class TripIt {
  private oauth: OAuth;

  constructor (consumerKey: string, consumerSecret: string) {
    this.oauth = new OAuth(
      "https://api.tripit.com/oauth/request_token",
      "https://api.tripit.com/oauth/access_token",
      consumerKey,
      consumerSecret,
      "1.0",
      null,
      "HMAC-SHA1"
    );
  }

	getRequestToken(): Promise<[string, string]> {
    const result = new Promise<[string, string]>((resolve, reject) => {
      this.oauth.getOAuthRequestToken((err, token, secret) => {
        if (err) reject(err);
        resolve([token, secret]);
      });
    });
    return result;
	}

	getAccessToken(requestToken: string, requestTokenSecret: string): Promise<[string, string]> {
    const result = new Promise<[string, string]>((resolve, reject) => {
      this.oauth.getOAuthAccessToken(requestToken, requestTokenSecret, (err, token, secret) => {
        if (err) reject(err);
        resolve([token, secret])
      })
    });
    return result;
	}

	requestResource<T>(path: string, method: string, accessToken: string, accessTokenSecret: string) {
		var url = "https://api.tripit.com/v1" + path + "/format/json";
    const result = new Promise<T>((resolve, reject) => {
      this.oauth.getProtectedResource(url, method, accessToken, accessTokenSecret, (err, data) => {
        if (err) reject(err);
        resolve(JSON.parse(data as string) as T);
      })
    });
    return result;
	}

  static convertDateTime(dt: TripItDateTime): Date {
    return DateTime
      .fromFormat(
        `${dt.date} ${dt.time}${dt.utc_offset}`,
        'yyyy-MM-dd HH:mm:ssZZ'
      )
      .toJSDate();
  }
}

export interface TripItDateTime {
  date: string
  time: string
  timezone: string
  utc_offset: string
}

export interface TripItTrip {
  TripInvitees: any[]
  id: string
  relative_url: string
  start_date: string
  end_date: string
  display_name: string
  image_url: string
  is_private: string
  primary_location: string
  PrimaryLocationAddress: {
    address: string
    city: string
    state: string
    country: string
    latitude: string
    longitude: string
  }
  TripPurposes: any[]
  last_modified: string
  is_trip_owner_inner_circle_sharer: string
  TripStatuses: any[]
}

export interface TripItFlightSegment {
  StartDateTime?: TripItDateTime
  EndDateTime?: TripItDateTime
  start_airport_code?: string
  start_city_name?: string
  end_airport_code?: string
  end_city_name: string
  marketing_airline: string
  marketing_airline_code: string
  marketing_flight_number: string
  aircraft: string
  distance: string
  duration: string
  stops: string
}

export interface TripItFlight {
  id: string
  trip_id: string
  is_traveler: boolean
  relative_url: string
  display_name: string
  booking_site_name?: string
  booking_site_email_address?: string
  booking_site_url?: string
  is_purchased: boolean
  Agency?: {
    agency_conf_num?: string
    agency_name?: string
    agency_phone?: string
    agency_email_address?: string
    agency_url?: string
    agency_contact?: string
    partner_agency_id?: number
  }
  Segment?: TripItFlightSegment[]
}

export interface TripItListTripResponse {
  Trip: TripItTrip[]
  page_num?: string
  page_size?: string
  max_page?: string
}