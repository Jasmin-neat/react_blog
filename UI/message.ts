import { PublicKey } from "https://raw.githubusercontent.com/BlowaterNostr/nostr.ts/main/key.ts";
import { MessageThread } from "./dm.tsx";
import { NostrEvent } from "https://raw.githubusercontent.com/BlowaterNostr/nostr.ts/main/nostr.ts";

export function* parseContent(content: string) {
    // URLs
    yield* match(/https?:\/\/[^\s]+/g, content, "url");

    // npubs
    yield* match(/nostr:npub[0-9a-z]{59}/g, content, "npub");

    // tags
    yield* match(/#\[[0-9]+\]/g, content, "tag");
}

function* match(regex: RegExp, content: string, type: ItemType): Generator<ContentItem, void, unknown> {
    let match;
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/RegExp/exec#return_value
    // If the match succeeds, the exec() method returns an array and
    // updates the lastIndex property of the regular expression object.
    while ((match = regex.exec(content)) !== null) {
        const urlStartPosition = match.index;
        if (urlStartPosition == undefined) {
            return;
        }
        const urlEndPosition = urlStartPosition + match[0].length - 1;
        yield {
            type: type,
            start: urlStartPosition,
            end: urlEndPosition,
        };
    }
}

type ItemType = "url" | "npub" | "tag";
export type ContentItem = {
    type: ItemType;
    start: number;
    end: number;
};

// Think of ChatMessage as an materialized view of NostrEvent
export interface ChatMessage {
    readonly event: NostrEvent;
    readonly type: "image" | "text";
    readonly created_at: Date;
    readonly lamport: number | undefined;
    readonly author: {
        pubkey: PublicKey;
        name?: string;
        picture?: string;
    };
    content: string;
}

export function isImage(message: ChatMessage) {
    if (message.type === "image") {
        return true;
    }
    const trimmed = message.content.trim();
    try {
        new URL(trimmed); // is URL otherwise throw a TypeError
        if (!urlIsImage(trimmed)) {
            return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

export function urlIsImage(url: string) {
    const trimmed = url.trim();
    const parts = trimmed.split(".");
    return ["png", "jpg", "jpeg", "gif", "webp"].includes(parts[parts.length - 1]);
}

export function* groupContinuousMessages<T>(
    seq: Iterable<T>,
    checker: (previousItem: T, currentItem: T) => boolean,
) {
    let previousItem: T | undefined;
    let group: T[] = [];
    for (const currentItem of seq) {
        if (previousItem == undefined || checker(previousItem, currentItem)) {
            group.push(currentItem);
        } else {
            yield group;
            group = [currentItem];
        }
        previousItem = currentItem;
    }
    yield group;
}

export function sortMessage(messages: MessageThread[]) {
    return messages
        .sort((m1, m2) => {
            if (m1.root.lamport && m2.root.lamport) {
                if (m1.root.lamport == m2.root.lamport) {
                    return m2.root.created_at.getTime() - m1.root.created_at.getTime();
                } else {
                    return m2.root.lamport - m1.root.lamport;
                }
            }
            return m2.root.created_at.getTime() - m1.root.created_at.getTime();
        });
}
