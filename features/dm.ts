import * as csp from "https://raw.githubusercontent.com/BlowaterNostr/csp/master/csp.ts";
import { NostrAccountContext, NostrEvent, NostrKind } from "../lib/nostr-ts/nostr.ts";
import { ConnectionPool } from "../lib/nostr-ts/relay.ts";
import {
    compare,
    DirectedMessage_Event,
    getTags,
    groupImageEvents,
    Parsed_Event,
    prepareNostrImageEvent,
    reassembleBase64ImageFromEvents,
    Tag,
} from "../nostr.ts";
import { PublicKey } from "../lib/nostr-ts/key.ts";
import { prepareEncryptedNostrEvent } from "../lib/nostr-ts/event.ts";
import { DirectMessageGetter } from "../UI/app_update.tsx";
import { parseDM } from "../database.ts";
import { ChatMessage } from "../UI/message.ts";
import { decodeInvitation, gmEventType } from "./gm.ts";

export async function sendDMandImages(args: {
    sender: NostrAccountContext;
    receiverPublicKey: PublicKey;
    message: string;
    files: Blob[];
    lamport_timestamp: number;
    pool: ConnectionPool;
    tags: Tag[];
}) {
    const { tags, sender, receiverPublicKey, message, files, lamport_timestamp, pool } = args;
    console.log("sendDMandImages", message, files);
    const eventsToSend: NostrEvent[] = [];
    if (message.trim().length !== 0) {
        // build the nostr event
        const nostrEvent = await prepareEncryptedNostrEvent(
            sender,
            {
                encryptKey: receiverPublicKey,
                kind: NostrKind.DIRECT_MESSAGE,
                tags: [
                    ["p", receiverPublicKey.hex],
                    ["lamport", String(lamport_timestamp)],
                    ...tags,
                ],
                content: message,
            },
        );
        if (nostrEvent instanceof Error) {
            return nostrEvent;
        }
        eventsToSend.push(nostrEvent);
    }
    for (let blob of files) {
        const imgEvent = await prepareNostrImageEvent(
            sender,
            receiverPublicKey,
            blob,
            NostrKind.DIRECT_MESSAGE,
            tags,
        );
        if (imgEvent instanceof Error) {
            return imgEvent;
        }
        let [fileEvent, _] = imgEvent;
        // for (const event of fileEvents) {
        eventsToSend.push(fileEvent);
        // }
    }
    // send the event
    for (const event of eventsToSend) {
        const err = await pool.sendEvent(event);
        if (err instanceof Error) {
            return err;
        }
    }
    return eventsToSend;
}

export function getAllEncryptedMessagesOf(
    publicKey: PublicKey,
    relay: ConnectionPool,
) {
    const stream1 = getAllEncryptedMessagesSendBy(
        publicKey,
        relay,
    );
    const stream2 = getAllEncryptedMessagesReceivedBy(
        publicKey,
        relay,
    );
    return merge(stream1, stream2);
}

async function* getAllEncryptedMessagesSendBy(
    publicKey: PublicKey,
    relay: ConnectionPool,
) {
    let resp = await relay.newSub(
        `getAllEncryptedMessagesSendBy`,
        {
            authors: [publicKey.hex],
            kinds: [4],
        },
    );
    if (resp instanceof Error) {
        throw resp;
    }
    for await (const nostrMessage of resp.chan) {
        yield nostrMessage;
    }
}

async function* getAllEncryptedMessagesReceivedBy(
    publicKey: PublicKey,
    relay: ConnectionPool,
) {
    let resp = await relay.newSub(
        `getAllEncryptedMessagesReceivedBy`,
        {
            kinds: [4],
            "#p": [publicKey.hex],
        },
    );
    if (resp instanceof Error) {
        throw resp;
    }
    for await (const nostrMessage of resp.chan) {
        yield nostrMessage;
    }
}

function merge<T>(...iters: AsyncIterable<T>[]) {
    let merged = csp.chan<T>();
    async function coroutine<T>(
        source: AsyncIterable<T>,
        destination: csp.Channel<T>,
    ) {
        for await (let ele of source) {
            if (destination.closed()) {
                return;
            }
            let err = await destination.put(ele);
            if (err instanceof csp.PutToClosedChannelError) {
                // this means the merged channel was not closed when
                // line 319 is called,
                // but during waiting time of line 319, no consumer pops it and it was closed.
                // This is normal semantics of channels
                // so that it's fine to not throw it up to the call stack
                // but then this ele has already been popped from the iter,
                // it will be lost.
                throw new Error("destination channel should not be closed");
            }
        }
    }
    for (let iter of iters) {
        coroutine(iter, merged);
    }
    return merged;
}

export class DirectedMessageController implements DirectMessageGetter {
    constructor(
        public readonly ctx: NostrAccountContext,
    ) {}

    public readonly directed_messages = new Map<string, ChatMessage>();

    // get the direct messages between me and this pubkey
    public getDirectMessages(pubkey: string): ChatMessage[] {
        const messages = [];
        for (const message of this.directed_messages.values()) {
            if (is_DM_between(message.event, this.ctx.publicKey.hex, pubkey)) {
                if (message.event.kind == NostrKind.Group_Message) {
                    console.log(message);
                }
                messages.push(message);
            }
        }
        messages.sort((a, b) => compare(a.event, b.event));
        return messages;
    }

    async addEvent(event: Parsed_Event<NostrKind.DIRECT_MESSAGE | NostrKind.Group_Message>) {
        const kind = event.kind;
        if (kind == NostrKind.Group_Message) {
            console.log("dm add event", kind);
            const gmEvent = { ...event, kind };
            const type = gmEventType(this.ctx, gmEvent);
            if (type == "gm_invitation") {
                const invitation = await decodeInvitation(this.ctx, gmEvent);
                if (invitation instanceof Error) {
                    return invitation;
                }
                console.log("dm add event", invitation);
                this.directed_messages.set(gmEvent.id, {
                    type: "text", // todo: change to invitation
                    event: gmEvent,
                    author: gmEvent.publicKey,
                    content: `You have been invited to group ${invitation.groupAddr.bech32()}`,
                    created_at: new Date(gmEvent.created_at * 1000),
                    // invitation: invitation,
                    lamport: gmEvent.parsedTags.lamport_timestamp,
                });
            }
            // else ignore
        } else {
            const dmEvent = await parseDM(
                {
                    ...event,
                    kind,
                },
                this.ctx,
                event.parsedTags,
                event.publicKey,
            );
            if (dmEvent instanceof Error) {
                return dmEvent;
            }
            const isImage = dmEvent.parsedTags.image;
            if (isImage) {
                const imageBase64 = reassembleBase64ImageFromEvents([dmEvent]);
                if (imageBase64 instanceof Error) {
                    return imageBase64;
                }
                this.directed_messages.set(event.id, {
                    event: dmEvent,
                    author: dmEvent.publicKey,
                    content: imageBase64,
                    type: "image",
                    created_at: new Date(dmEvent.created_at * 1000),
                    lamport: dmEvent.parsedTags.lamport_timestamp,
                });
            } else {
                this.directed_messages.set(event.id, {
                    event: dmEvent,
                    author: dmEvent.publicKey,
                    content: dmEvent.decryptedContent,
                    type: "text",
                    created_at: new Date(dmEvent.created_at * 1000),
                    lamport: dmEvent.parsedTags.lamport_timestamp,
                });
            }
        }
    }
}

function is_DM_between(event: NostrEvent, myPubkey: string, theirPubKey: string) {
    if (event.pubkey == myPubkey) {
        return getTags(event).p[0] == theirPubKey;
    } else if (event.pubkey == theirPubKey) {
        return getTags(event).p[0] == myPubkey;
    } else {
        return false;
    }
}
