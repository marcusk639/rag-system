import React, { useRef, useState } from "react";
import { Send } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { CardContent } from "@/components/ui/card";
import { askStream } from "@/lib/stream-chat";
import { AnswerFeedback } from "@/components/answer-feedback";
import type { ChatSession, Citation, Message, Source } from "@/types";

/**
 * Mirrors `EMPTY_ANSWER` from `@rag/services` (packages/services/src/ask.ts).
 * Duplicated as a literal instead of imported: `@rag/services` re-exports the
 * whole service module graph, which pulls the local ONNX embedder
 * (onnxruntime-node's native binding) into this client bundle and breaks
 * `next build` ("Module parse failed" on the .node binary). Keep this string
 * in sync with the source of truth if it ever changes.
 */
const EMPTY_ANSWER =
  "The available documents do not contain enough information to answer that.";

interface ChatInterfaceProps {
  session: ChatSession;
  selectedSource: Source | null;
  addMessage: (message: Message) => void;
  updateMessage: (
    messageId: string,
    patch: {
      appendContent?: string;
      citations?: Citation[];
      answerId?: string;
      error?: string;
    },
  ) => void;
  onCitationClick?: (citation: Citation) => void;
}

let msgCounter = 0;
const newMessageId = () => `msg-${Date.now()}-${msgCounter++}`;

export const ChatInterface: React.FC<ChatInterfaceProps> = ({
  session,
  selectedSource,
  addMessage,
  updateMessage,
  onCitationClick,
}) => {
  const [chatMessage, setChatMessage] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleSendMessage = async () => {
    const question = chatMessage.trim();
    if (!question || streaming) return;

    addMessage({ id: newMessageId(), role: "user", content: question });
    const assistantId = newMessageId();
    addMessage({ id: assistantId, role: "assistant", content: "" });
    setChatMessage("");
    setStreaming(true);

    try {
      await askStream(
        {
          question,
          sourceIds: selectedSource ? [selectedSource.id] : undefined,
        },
        {
          onToken: (text) =>
            updateMessage(assistantId, { appendContent: text }),
          onDone: (citations, answerId) =>
            updateMessage(assistantId, { citations, answerId }),
          onError: (message) => updateMessage(assistantId, { error: message }),
        },
      );
    } finally {
      setStreaming(false);
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  };

  return (
    <CardContent className="flex-1 overflow-hidden">
      <div className="flex flex-col h-full">
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto mb-4">
          {session.messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${
                message.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-[85%] p-3 rounded-lg ${
                  message.role === "user"
                    ? "bg-blue-500 text-white"
                    : "bg-gray-100 text-gray-800"
                }`}
              >
                {message.role === "assistant" ? (
                  <>
                    <div
                      data-testid="assistant-message"
                      className="prose prose-sm max-w-none break-words"
                    >
                      <ReactMarkdown>{message.content || "…"}</ReactMarkdown>
                    </div>
                    {message.content.includes(EMPTY_ANSWER) && (
                      <span data-testid="refusal" />
                    )}
                    {message.error && (
                      <div
                        data-testid="stream-error"
                        className="mt-2 text-xs text-red-700"
                      >
                        {message.error}
                      </div>
                    )}
                    {message.citations && message.citations.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {message.citations.map((c) => (
                          <button
                            key={c.index}
                            data-testid="citation-chip"
                            data-doc-id={c.documentId}
                            onClick={() => onCitationClick?.(c)}
                            title={c.title}
                            className="inline-flex items-center rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-200"
                          >
                            [{c.index}] {c.title}
                          </button>
                        ))}
                      </div>
                    )}
                    {message.content && !streaming && (
                      <AnswerFeedback answerId={message.answerId} />
                    )}
                    {message.content && (
                      // Non-dismissible practitioner-review disclaimer on every
                      // AI answer (Circular 230 §10.37). Server-enforced too —
                      // the /ask response carries `reviewStatus`/`disclaimer`.
                      <p
                        role="note"
                        className="mt-2 border-t border-amber-200 pt-2 text-xs italic text-amber-700"
                      >
                        Draft — AI-generated and may be inaccurate. Requires
                        review by a qualified practitioner before use.
                      </p>
                    )}
                  </>
                ) : (
                  message.content
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-col space-y-2">
          {selectedSource && (
            <div className="text-sm text-gray-500 px-2">
              Scoped to source: {selectedSource.name}
            </div>
          )}
          <div className="flex space-x-2">
            <input
              type="text"
              placeholder="Ask about your documents..."
              className="flex-1 p-3 rounded-lg border border-gray-200"
              value={chatMessage}
              disabled={streaming}
              onChange={(e) => setChatMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSendMessage();
              }}
            />
            <button
              className="bg-blue-500 text-white px-4 py-2 rounded hover:bg-blue-600 disabled:opacity-50"
              onClick={handleSendMessage}
              disabled={streaming}
            >
              <Send size={20} />
            </button>
          </div>
        </div>
      </div>
    </CardContent>
  );
};
