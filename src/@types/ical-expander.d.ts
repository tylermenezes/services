declare module 'ical-expander' {
  import { Event, OccuranceDetails } from 'ical.js';

  export interface IcalExpanderArgs {
    ics: string;
    maxIterations?: number;
  }

  export interface IcalExpanderResult {
    events: Event[];
    occurrences: OccuranceDetails[];
  }

  export default class IcalExpander {
    constructor(args: IcalExpanderArgs);

    between(after?: Date, before?: Date): IcalExpanderResult;

    before(before: Date): IcalExpanderResult;

    after(after: Date): IcalExpanderResult;

    all(): IcalExpanderResult;
  }
}