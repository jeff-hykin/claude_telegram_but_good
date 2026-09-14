// lib/pure/group-topic.js — the topic-memory name for a group chat.
//
// A command-center topic names its memory directory after the Telegram
// forum topic. A group chat has no forum topic, so its name is derived
// from the group's own title instead.
//
// The result becomes a directory under `topics/`, so it is sanitized:
// a title is arbitrary user text and may contain slashes, dots or
// control characters that would otherwise escape the topics directory.
// A group with no usable title falls back to its chat id, which is
// stable and unique.

const MAX_NAME_LENGTH = 64

export function groupTopicName(chatId, title) {
    const cleaned = String(title ?? "")
        .replace(/[\\/]/g, "-")
        // deno-lint-ignore no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        // A name that is only dots would be "." or ".." — a directory
        // traversal rather than a topic.
        .replace(/^\.+/, "")
        .trim()
        .slice(0, MAX_NAME_LENGTH)
        .trim()
    if (cleaned) { return cleaned }
    return `group${String(chatId).replace(/[^\d-]/g, "")}`
}
