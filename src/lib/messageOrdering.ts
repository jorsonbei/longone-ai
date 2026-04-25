import type { Message } from '../types';

function getMessageTime(message: Message) {
  return typeof message.createdAt === 'number' ? message.createdAt : 0;
}

function getAnchorTime(message: Message, byId: Map<string, Message>) {
  if (message.replyToId) {
    const source = byId.get(message.replyToId);
    if (source) {
      return getMessageTime(source);
    }
  }

  return getMessageTime(message);
}

function getTurnOrder(message: Message) {
  return message.role === 'user' ? 0 : 1;
}

export function normalizeMessageOrder(messages: Message[]) {
  const byId = new Map(messages.map((message) => [message.id, message]));

  return [...messages].sort((a, b) => {
    const anchorDelta = getAnchorTime(a, byId) - getAnchorTime(b, byId);
    if (anchorDelta !== 0) return anchorDelta;

    const turnDelta = getTurnOrder(a) - getTurnOrder(b);
    if (turnDelta !== 0) return turnDelta;

    const timeDelta = getMessageTime(a) - getMessageTime(b);
    if (timeDelta !== 0) return timeDelta;

    return a.id.localeCompare(b.id);
  });
}
