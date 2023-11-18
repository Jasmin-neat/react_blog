import { NostrEvent } from "./lib/nostr-ts/nostr.ts";
import { getTags } from "./nostr.ts";

export class LamportTime {
    constructor(private time: number) {}

    static FromEvents(events: Iterable<NostrEvent>) {
        let time = 0;
        for (const event of events) {
            const ts = getTags(event).lamport_timestamp;
            if (ts && ts > time) {
                time = ts;
            }
        }
        return new LamportTime(time);
    }

    now() {
        this.time++;
        return this.time;
    }
    set(t: number) {
        this.time = Math.max(this.time, t);
    }
}
