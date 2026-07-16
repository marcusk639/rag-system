import { CardFactory } from "botbuilder";
import type { Attachment } from "botbuilder";
import type { AskAnswer } from "./rag-client.js";

interface AdaptiveCardElement {
  type: string;
  text: string;
  wrap?: boolean;
  weight?: string;
  spacing?: string;
  color?: string;
  size?: string;
  selectAction?: Record<string, unknown>;
}

interface AdaptiveCard {
  $schema: string;
  type: string;
  version: string;
  body: AdaptiveCardElement[];
}

export function answerCard(a: AskAnswer): Attachment {
  const body: AdaptiveCardElement[] = [];

  // Add answer text
  body.push({
    type: "TextBlock",
    text: a.answer,
    wrap: true,
  });

  // Add citations if any
  if (a.citations.length > 0) {
    body.push({
      type: "TextBlock",
      text: "Sources:",
      weight: "Bolder",
      spacing: "Medium",
    });

    for (const citation of a.citations) {
      const citationItem: AdaptiveCardElement = {
        type: "TextBlock",
        text: `${citation.index}. ${citation.title}`,
        wrap: true,
      };

      // Add OpenUrl action only when we have a real, absolute http(s) source url.
      // Do NOT derive a link from documentId/downloadable — that endpoint is
      // auth-gated and unreachable from a Teams card.
      if (
        typeof citation.url === "string" &&
        /^https?:\/\//.test(citation.url)
      ) {
        citationItem.selectAction = {
          type: "Action.OpenUrl",
          url: citation.url,
        };
      }

      body.push(citationItem);
    }
  }

  // Add disclaimer as a distinct footer
  body.push({
    type: "TextBlock",
    text: a.disclaimer,
    weight: "Bolder",
    color: "Warning",
    wrap: true,
    spacing: "Large",
    size: "Small",
  });

  const card: AdaptiveCard = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body,
  };

  return CardFactory.adaptiveCard(card);
}

export function emptyScopeCard(kind: "dm" | "channel"): Attachment {
  const message =
    kind === "dm"
      ? "You don't have access to any knowledge sources yet — ask an admin to grant you access."
      : "No firm-wide sources are available to everyone in this channel. Ask me in a direct message to search everything you personally have access to.";

  const card: AdaptiveCard = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: message,
        wrap: true,
      },
    ],
  };

  return CardFactory.adaptiveCard(card);
}

export function errorCard(message: string): Attachment {
  const card: AdaptiveCard = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: message,
        wrap: true,
        color: "Attention",
      },
    ],
  };

  return CardFactory.adaptiveCard(card);
}
