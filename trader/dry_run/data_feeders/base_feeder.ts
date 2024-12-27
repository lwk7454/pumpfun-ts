import { TokenEvent } from '@/trader/interfaces.ts';

export abstract class BaseDataFeeder {
  protected startDate: Date
  protected endDate: Date

  constructor (startDate: Date, endDate: Date){
    this.startDate = startDate
    this.endDate = endDate
  }

  abstract nextEvent(): AsyncGenerator<TokenEvent>
}

