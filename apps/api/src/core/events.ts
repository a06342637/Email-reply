import { Injectable } from "@nestjs/common";
import { Subject } from "rxjs";

export type AppEvent = { type: string; at: string; data?: unknown };

@Injectable()
export class EventBus {
  private readonly subject = new Subject<AppEvent>();
  readonly stream = this.subject.asObservable();

  emit(type: string, data?: unknown): void {
    this.subject.next({ type, at: new Date().toISOString(), data });
  }
}
