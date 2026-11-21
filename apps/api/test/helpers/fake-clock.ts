import type { Clock } from '../../src/core/clock/clock';

export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date = new Date()) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(date: Date): void {
    this.current = date.getTime();
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
