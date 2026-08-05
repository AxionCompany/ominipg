/** Small runtime-neutral typed emitter used by the public client. */

type Listener = (...args: never[]) => void;
type ListenerEntry = Readonly<{
  listener: Listener;
  once: boolean;
}>;

export class TypedEmitter<
  Events extends { [Event in keyof Events]: (...args: never[]) => void },
> {
  private readonly entries = new Map<keyof Events, ListenerEntry[]>();
  private maxListeners = 10;

  on<Event extends keyof Events>(event: Event, listener: Events[Event]): this {
    return this.add(event, listener, false, false);
  }

  addListener<Event extends keyof Events>(
    event: Event,
    listener: Events[Event],
  ): this {
    return this.on(event, listener);
  }

  prependListener<Event extends keyof Events>(
    event: Event,
    listener: Events[Event],
  ): this {
    return this.add(event, listener, false, true);
  }

  once<Event extends keyof Events>(
    event: Event,
    listener: Events[Event],
  ): this {
    return this.add(event, listener, true, false);
  }

  prependOnceListener<Event extends keyof Events>(
    event: Event,
    listener: Events[Event],
  ): this {
    return this.add(event, listener, true, true);
  }

  off<Event extends keyof Events>(event: Event, listener: Events[Event]): this {
    const entries = this.entries.get(event);
    if (!entries) return this;
    let index = entries.length - 1;
    while (
      index >= 0 && entries[index].listener !== listener as Listener
    ) index--;
    if (index >= 0) entries.splice(index, 1);
    if (entries.length === 0) this.entries.delete(event);
    return this;
  }

  removeListener<Event extends keyof Events>(
    event: Event,
    listener: Events[Event],
  ): this {
    return this.off(event, listener);
  }

  removeAllListeners<Event extends keyof Events>(event?: Event): this {
    if (event === undefined) this.entries.clear();
    else this.entries.delete(event);
    return this;
  }

  listenerCount<Event extends keyof Events>(
    event: Event,
    listener?: Events[Event],
  ): number {
    const entries = this.entries.get(event) ?? [];
    return listener
      ? entries.filter((entry) => entry.listener === listener as Listener)
        .length
      : entries.length;
  }

  listeners<Event extends keyof Events>(event: Event): Events[Event][] {
    return (this.entries.get(event) ?? []).map((entry) =>
      entry.listener as Events[Event]
    );
  }

  rawListeners<Event extends keyof Events>(event: Event): Events[Event][] {
    return this.listeners(event);
  }

  eventNames(): Array<keyof Events> {
    return [...this.entries.keys()];
  }

  getMaxListeners(): number {
    return this.maxListeners;
  }

  setMaxListeners(maxListeners: number): this {
    if (!Number.isSafeInteger(maxListeners) || maxListeners < 0) {
      throw new RangeError("maxListeners must be a non-negative integer.");
    }
    this.maxListeners = maxListeners;
    return this;
  }

  emit<Event extends keyof Events>(
    event: Event,
    ...args: Parameters<Events[Event]>
  ): boolean {
    const entries = this.entries.get(event);
    if (!entries?.length) return false;
    for (const entry of [...entries]) {
      if (entry.once) this.removeEntry(event, entry);
      (entry.listener as Events[Event])(...args);
    }
    return true;
  }

  private add<Event extends keyof Events>(
    event: Event,
    listener: Events[Event],
    once: boolean,
    prepend: boolean,
  ): this {
    if (typeof listener !== "function") {
      throw new TypeError("listener must be a function.");
    }
    const entries = this.entries.get(event) ?? [];
    const entry = { listener: listener as Listener, once };
    if (prepend) entries.unshift(entry);
    else entries.push(entry);
    this.entries.set(event, entries);
    return this;
  }

  private removeEntry<Event extends keyof Events>(
    event: Event,
    entry: ListenerEntry,
  ): void {
    const entries = this.entries.get(event);
    if (!entries) return;
    const index = entries.indexOf(entry);
    if (index >= 0) entries.splice(index, 1);
    if (entries.length === 0) this.entries.delete(event);
  }
}
