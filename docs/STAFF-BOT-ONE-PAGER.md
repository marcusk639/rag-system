# Ask the Knowledge Base in Microsoft Teams

**Status:** ⛔ **NOT YET FOR DISTRIBUTION** — updated 2026-08-03.
**Why:** the Teams bot described below is **not deployed** (blocked on an Azure
subscription), and the content-scope statement in an earlier version of this page
was **incorrect**. Do not hand this to staff until both are resolved.

> ### What changed, and what needs to happen first
>
> 1. **Teams is not the live surface.** The bot is built and merged but needs an
>    Azure Bot resource, which needs an Azure subscription the firm does not
>    currently have (`docs/TWK-LAUNCH-STATUS.md` P1 #4). **The web app is what is
>    actually deployed.** Before sending this out, replace the Teams instructions
>    below with the web-app URL and sign-in steps.
> 2. **The old "it does not have your client files" line was wrong** — see
>    [What's in it](#whats-in-it). That sentence must not go to staff in its
>    original form.

---

## How to ask — ⚠ describes a surface that is not live yet

**In a direct message (recommended):**

1. In Teams, search for **the knowledge base** in the chat/search bar and open a chat with it (or find it in your Teams apps).
2. Type your question in plain English and send. Examples:
   - "What's our intake checklist for a new 1040 client?"
   - "What's the SOP for a BOI filing?"
   - "Which time code do I use for research?"
3. You'll get an answer with **numbered citations** to the source documents, so you can verify it.

**In a channel:**

- **@mention** the bot: `@the knowledge base what's our engagement letter template?`
- Everyone in the channel sees the answer, so in channels the bot only uses **firm-wide** documents that everyone already has access to. For anything tied to your personal access, ask it in a **direct message** instead.

---

## What to expect

- **Every answer is a draft.** The bot marks each answer _"AI-generated draft — verify before relying on it."_ Treat it like a helpful starting point from a colleague, not a final authority. **Always confirm against the cited document before acting**, especially for anything client-facing or filing-related.
- **It answers as you.** You only see answers built from documents you're allowed to see. If you get "you don't have access to any knowledge sources yet," ask an admin to grant you access.

### What's in it

It is connected to the **firm's SharePoint knowledge base only**. It is not
connected to Onvio, the Z Drive, or QuickBooks, and it never will be — that
boundary is a connection setting, not a promise about individual documents.

⚠ **A previous version of this page said the knowledge base contains no client
files. That was not correct**, and the correction matters more than the original
claim did. A screen of the indexed SharePoint library found client-identifying
material inside it — per-client billing and package files, engagement letters,
and folders named after clients. Those documents are being removed from the index
(`docs/superpowers/plans/2026-08-03-kb-content-boundary.md`), but until that work
finishes and a firm reviewer signs it off:

- **Assume a citation can name a client.** If you see one, that is a finding —
  report it rather than ignoring it.
- **Nothing from here goes into a client deliverable or a filed position.**
- The pilot stays limited to named users. It is not firm-wide yet.

### Signing in

**The first time you use it**, it will ask you to sign in with your Microsoft
account — the same one you use for Outlook and Teams. That is how it knows it is
really you, and it is what limits your answers to documents you are allowed to
see.

---

## Tips

- Ask **specific** questions ("what's the SOP for X") rather than broad ones ("tell me about taxes").
- If an answer looks off or the citations don't match, **don't rely on it** — check the source doc or ask a person. Flag it so we can improve the knowledge base.
- Can't find the bot, or getting "no access"? Contact Marcus.

---

_This is a pilot. Your questions help us find gaps in the knowledge base — the more it's used, the better it gets._
