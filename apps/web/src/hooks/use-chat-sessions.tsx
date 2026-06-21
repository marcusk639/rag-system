import { useCallback, useState } from "react";
import type { ChatSession, Citation, Message } from "@/types";

let counter = 0;
const nextId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${counter++}`;

const createSession = (name: string): ChatSession => ({
  id: nextId("session"),
  name,
  messages: [],
});

/**
 * Ephemeral, in-memory chat sessions. No persistence, no backend, no
 * localStorage — a page reload clears all history (by design, per the plan).
 */
export const useChatSessions = () => {
  const [sessions, setSessions] = useState<ChatSession[]>(() => [
    createSession("New Chat"),
  ]);
  const [currentId, setCurrentId] = useState<string>(() => sessions[0].id);

  const currentSession =
    sessions.find((s) => s.id === currentId) ?? sessions[0];

  const createNewSession = useCallback(() => {
    setSessions((prev) => {
      const session = createSession(`New Chat ${prev.length + 1}`);
      setCurrentId(session.id);
      return [...prev, session];
    });
  }, []);

  const switchSession = useCallback((session: ChatSession) => {
    setCurrentId(session.id);
  }, []);

  const addMessage = useCallback(
    (message: Message): void => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === currentId ? { ...s, messages: [...s.messages, message] } : s,
        ),
      );
    },
    [currentId],
  );

  /** Append text to / set citations on an existing message (streaming updates). */
  const updateMessage = useCallback(
    (
      messageId: string,
      patch: { appendContent?: string; citations?: Citation[] },
    ): void => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== currentId) return s;
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== messageId) return m;
              return {
                ...m,
                content:
                  patch.appendContent !== undefined
                    ? m.content + patch.appendContent
                    : m.content,
                citations: patch.citations ?? m.citations,
              };
            }),
          };
        }),
      );
    },
    [currentId],
  );

  return {
    sessions,
    currentSession,
    createNewSession,
    switchSession,
    addMessage,
    updateMessage,
  };
};
