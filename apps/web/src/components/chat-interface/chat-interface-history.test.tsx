import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChatInterface } from "./chat-interface";
import type { ChatSession } from "@/types";

const { askStreamMock } = vi.hoisted(() => ({
  askStreamMock: vi.fn(async () => undefined),
}));
vi.mock("@/lib/stream-chat", () => ({ askStream: askStreamMock }));

describe("ChatInterface conversation history", () => {
  afterEach(cleanup);

  it("sends the prior completed turns with a follow-up question", async () => {
    const session: ChatSession = {
      id: "s",
      name: "S",
      messages: [
        { id: "1", role: "user", content: "How do I set up a bookkeeping client?" },
        { id: "2", role: "assistant", content: "Apply BK-CATCHUP [1].", answerId: "a" },
      ],
    };
    render(
      <ChatInterface
        session={session}
        selectedSource={null}
        addMessage={() => {}}
        updateMessage={() => {}}
      />,
    );

    const input = screen.getByRole("textbox", {
      name: "Ask about your documents",
    });
    fireEvent.change(input, { target: { value: "and for payroll?" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await vi.waitFor(() => expect(askStreamMock).toHaveBeenCalled());
    const request = (askStreamMock.mock.calls[0] as unknown[])[0];
    expect(request).toMatchObject({
      question: "and for payroll?",
      history: [
        { role: "user", content: "How do I set up a bookkeeping client?" },
        { role: "assistant", content: "Apply BK-CATCHUP [1]." },
      ],
    });
  });
});
