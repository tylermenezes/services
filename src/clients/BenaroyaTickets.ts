import { sleep } from '@/utils/sleep';
import debug from 'debug';

const DEBUG = debug('services:clients:BenaroyaTickets');

export class BenaroyaTickets {
    async fetchAllSectionTickets(
        performanceId: string,
        facilityId: string,
        screenIds: string[]
    ) {
        let soldSeats = 0;
        let totalSeats = 0;
        for (const screenId of screenIds) {
            DEBUG(`Fetching screen ${screenId}...`);
            try {
                const screenSeats = await this.fetchTickets(performanceId, facilityId, screenId);
                soldSeats += screenSeats.soldSeats.length;
                totalSeats += screenSeats.totalSeats;
                await sleep(5000);
            } catch (ex) { DEBUG(ex); }
        }
        DEBUG(`Found ${soldSeats}/${totalSeats} seats.`);
        return { soldSeats, totalSeats }
    }
    async fetchTickets(
        performanceId: string,
        facilityId: string,
        screenId: string
    ) {
        const url = `https://cart.seattlesymphony.org/api/syos/GetSeatList?performanceId=${performanceId}&facilityId=${facilityId}&screenId=${screenId}&priceTypeIds=`;
        DEBUG(`Fetching ${url}`);
        const response = await fetch(url, {
            "credentials": "include",
            "headers": {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0",
                "Accept": "application/json, text/javascript, */*; q=0.01",
                "Accept-Language": "en-US,en;q=0.5",
                "X-Requested-With": "XMLHttpRequest",
                "Sec-Fetch-Dest": "empty",
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "same-origin",
                "Priority": "u=0"
            },
            "referrer": "https://cart.seattlesymphony.org/",
            "method": "GET",
            "mode": "cors"
        });

        const resp = await response.json();
        if (!resp.seats) throw new Error(JSON.stringify(resp));
        const soldSeats = resp.seats.filter((seat: any) => seat.seat_status_desc === 'Unavailable');
        const totalSeats = resp.seats.length;

        DEBUG(`Found ${soldSeats.length} seats.`);

        return { soldSeats, totalSeats };
    }
}