import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { EMPTY_ANSWER } from "@rag/services";
import { ChatInterface } from "./chat-interface";
import type { ChatSession, Message } from "@/types";

// The real ChatInterface takes a `session`/`addMessage`/`updateMessage` API
// (see apps/web/src/hooks/use-chat-sessions.tsx), not a bare `messages` array
// — the task brief's snippet showed the assertion, not the component's real
// props. This builds a minimal session around one assistant message so the
// component under test sees exactly the props it uses in production.
const sessionWith = (message: Message): ChatSession => ({
  id: "session-1",
  name: "Test session",
  messages: [message],
});

const noop = () => {};

describe("ChatInterface data-testid hooks", () => {
  // RTL doesn't auto-register its cleanup hook unless vitest's `globals`
  // option is on (it isn't, repo-wide) — clean up explicitly so one test's
  // render can't leak DOM nodes into the next.
  afterEach(cleanup);

  it("renders a stream error in its own element, not in the message body", () => {
    render(
      <ChatInterface
        session={sessionWith({
          id: "1",
          role: "assistant",
          content: "",
          error: "boom",
        })}
        selectedSource={null}
        addMessage={noop}
        updateMessage={noop}
      />,
    );

    expect(screen.getByTestId("stream-error")).toHaveTextContent("boom");
    expect(screen.getByTestId("assistant-message")).not.toHaveTextContent(
      "boom",
    );
    // A stream error is not a refusal — the two must never collapse into
    // the same node.
    expect(screen.queryByTestId("refusal")).not.toBeInTheDocument();
  });

  it("renders a refusal marker when the answer contains EMPTY_ANSWER, distinct from a stream error", () => {
    render(
      <ChatInterface
        session={sessionWith({
          id: "2",
          role: "assistant",
          // Branch C of the generation prompt appends a "Closest related
          // material" trailer after the refusal sentence — assert with
          // .includes()-style containment (via getByTestId + the raw
          // message text below), never `===`, so that trailer doesn't
          // defeat the classification.
          content: `${EMPTY_ANSWER} Closest related material: Onboarding Guide [1]`,
        })}
        selectedSource={null}
        addMessage={noop}
        updateMessage={noop}
      />,
    );

    expect(screen.getByTestId("refusal")).toBeInTheDocument();
    expect(screen.queryByTestId("stream-error")).not.toBeInTheDocument();
  });

  it("tags citation chips with a testid and the citation's document id", () => {
    render(
      <ChatInterface
        session={sessionWith({
          id: "3",
          role: "assistant",
          content: "Here is the answer [1].",
          citations: [
            {
              index: 1,
              documentId: "doc-abc",
              title: "Onboarding Guide",
              chunkId: "chunk-1",
              score: 0.9,
            },
          ],
        })}
        selectedSource={null}
        addMessage={noop}
        updateMessage={noop}
        onCitationClick={vi.fn()}
      />,
    );

    const chip = screen.getByTestId("citation-chip");
    expect(chip).toHaveAttribute("data-doc-id", "doc-abc");
  });
});
