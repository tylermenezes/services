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
  PrimaryLocationAddress: any[]
  TripPurposes: any[]
  last_modified: string
  is_trip_owner_inner_circle_sharer: string
  TripStatuses: any[]
}

export interface TripItListTripResponse {
  Trip: TripItTrip[]
}