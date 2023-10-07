import { NostrEvent } from "../lib/nostr-ts/nostr.ts";
import {
    DirectedMessage_Event,
    getTags,
    groupImageEvents,
    reassembleBase64ImageFromEvents,
} from "../nostr.ts";
import { ChatMessage } from "./message.ts";
import { PublicKey } from "../lib/nostr-ts/key.ts";
import { EditorModel } from "./editor.tsx";

export type DM_Model = {
    currentEditor: EditorModel | undefined;
    focusedContent: Map<string, NostrEvent /* thread root event */ | PublicKey /* selected user profile */>;
    isGroupMessage: boolean;
};

export function convertEventsToChatMessages(
    events: Iterable<DirectedMessage_Event>,
): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const groups = groupImageEvents(events);
    let pubKeys = Array.from(groups.values()).map((es) => es[0].pubkey);

    let textEvents = groups.get(undefined);
    if (textEvents === undefined) {
        textEvents = [];
    }
    pubKeys = pubKeys.concat(textEvents.map((e) => e.pubkey));

    groups.delete(undefined);

    for (let i = 0; i < textEvents.length; i++) {
        const pubkey = PublicKey.FromHex(textEvents[i].pubkey);
        if (pubkey instanceof Error) {
            throw new Error(textEvents[i].pubkey);
        }
        messages.push({
            event: textEvents[i],
            author: pubkey,
            content: textEvents[i].decryptedContent,
            type: "text",
            created_at: new Date(textEvents[i].created_at * 1000),
            lamport: getTags(textEvents[i]).lamport_timestamp,
        });
    }

    for (const imageEvents of groups.values()) {
        const imageBase64 = reassembleBase64ImageFromEvents(imageEvents);
        if (imageBase64 instanceof Error) {
            console.info(imageBase64.message);
            continue;
        }
        const pubkey = PublicKey.FromHex(imageEvents[0].pubkey);
        if (pubkey instanceof Error) {
            throw new Error(imageEvents[0].pubkey);
        }
        messages.push({
            event: imageEvents[0],
            author: pubkey,
            content: imageBase64,
            type: "image",
            created_at: new Date(imageEvents[0].created_at * 1000),
            lamport: getTags(imageEvents[0]).lamport_timestamp,
        });
    }

    return messages;
}
