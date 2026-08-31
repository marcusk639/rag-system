/**
 * CPA-representative labeled retrieval-eval corpus — entirely SYNTHETIC.
 *
 * ## Purpose
 *
 * Measures retrieval quality against language that looks like the real
 * knowledge base, rather than against the generic technical prose in
 * `corpus.ts`. Same shape, same harness, different difficulty.
 *
 * ## Why this is separate from `corpus.ts`
 *
 * `corpus.ts` is deliberately a STARTER set: its documents are
 * vocabulary-distinctive (pgvector, RRF, WAL archiving), so a bag-of-words
 * `FakeEmbedder` can separate them on keyword overlap alone. `run-real-eval.ts`
 * says so in its own report header — treat those numbers as a floor, not a
 * ceiling.
 *
 * This corpus removes that cushion. Firm SOPs share vocabulary heavily: several
 * documents say "client," "engagement," "Karbon," "time entry." A retriever
 * that scored well on the starter set can still fail here, which is the point —
 * a score that cannot go down measures nothing.
 *
 * ## Contents
 *
 * - `EVAL_DOCS_CPA` — 7 documents (BOI filing, time coding, K-1 treatment,
 *   1040 intake, catch-up bookkeeping, Karbon templates, staff onboarding).
 * - `EVAL_QUESTIONS_CPA` — 20 positives, each labeled with the `externalId`(s)
 *   that should answer it.
 * - `EVAL_NEGATIVES_CPA` — 8 out-of-corpus questions with `relevant: []`.
 *   Nothing in the corpus answers them (R&D credit, 1031 exchange, FBAR...).
 *   These exist because precision/recall alone cannot catch a system that
 *   answers everything confidently. A negative FAILS when the retriever returns
 *   a high-scoring hit that a generator would then cite. `corpus.ts` has no
 *   equivalent, so this is the only place that failure mode is measurable.
 *
 * ## Usage
 *
 * `runRetrievalEval` already accepts questions, so the positives drop straight
 * in:
 *
 * ```ts
 * import { EVAL_DOCS_CPA, EVAL_QUESTIONS_CPA } from "./corpus-cpa.js";
 *
 * const idMap = await seedEvalCorpus(db, sourceId, embedder);
 * const report = await runRetrievalEval(db, idMap, {
 *   weights: { dense: 0.7, sparse: 0.3 },
 *   questions: EVAL_QUESTIONS_CPA,
 *   embedder,
 * });
 * console.log(formatReport(report));
 * ```
 *
 * ⚠ **`seedEvalCorpus` does NOT take a document set yet** — it is hardcoded to
 * `EVAL_DOCS` from `corpus.ts`. Running the snippet above as written evaluates
 * CPA questions against the WRONG corpus and every metric reads ~0. Until
 * `seedEvalCorpus` grows a `docs` parameter, seed directly:
 *
 * ```ts
 * const connector = new FakeConnector(
 *   EVAL_DOCS_CPA.map((d) =>
 *     plainTextDoc({ externalId: d.externalId, title: d.title, text: d.text }),
 *   ),
 * );
 * await runOneIngestion(db, sourceId, connector, { embedder });
 * ```
 *
 * For the negatives, assert on the scores rather than on rank position — a
 * miss here means "returned something confident," not "ranked it low."
 *
 * ## Two constraints that produce silently wrong numbers
 *
 * 1. **Use one embedder instance for both seeding and querying.** Different
 *    instances mean dense scores compare vectors from two embedding spaces, and
 *    the run still completes — it just reports nonsense.
 * 2. **`poolK` must be >= the largest `k`.** Otherwise recall@k is capped by
 *    fetch depth and you are measuring the pool size, not the retriever.
 *
 * ## Content safety
 *
 * Every document is fabricated. No real firm SOP, no client identifier, no
 * taxpayer data. Every title carries a `SYNTHETIC SAMPLE` marker so it is
 * recognizable as fixture material if it ever surfaces in a retrieval result or
 * a generated answer during debugging.
 */
import type { EvalDoc, EvalQuestion } from "./corpus.js";

/**
 * The corpus under test. Seven documents that deliberately share vocabulary —
 * "client," "engagement," "Karbon," "time entry" recur across several — so
 * near-neighbor discrimination is actually exercised rather than assumed.
 *
 * `externalId` is the ground-truth key: it is what `EVAL_QUESTIONS_CPA.relevant`
 * refers to and what the connector ingests as its external id. Renaming one
 * without updating every reference silently drops those questions to zero
 * recall, because a label that matches nothing simply never scores.
 */
export const EVAL_DOCS_CPA: EvalDoc[] = [
  {
    externalId: "boi-filing",
    title: "BOI Filing SOP (SYNTHETIC SAMPLE)",
    text: "Beneficial Ownership Information (BOI) filing process for entities under the Corporate Transparency Act. For an LLC formed in 2024, file the initial BOIR with FinCEN within 90 days of formation. Collect each beneficial owner's full legal name, date of birth, residential address, and an identifying document (driver's license or passport) image. Company applicants must be reported for entities formed on or after 2024-01-01. Updated reports are due within 30 days of any ownership change.",
  },
  {
    externalId: "time-coding",
    title: "Time Coding Guide (SYNTHETIC SAMPLE)",
    text: "Time-code catalog for Karbon time entries. Use code TAX-PREP for return preparation, TAX-REV for reviewer passes, BK-CATCHUP for catch-up bookkeeping engagements, ADMIN-INT for internal administrative work, and ADV-PLAN for advisory and tax-planning sessions. Every time entry must carry a client, a work item, and a billable/non-billable flag. Catch-up bookkeeping is always coded BK-CATCHUP, never ADMIN-INT.",
  },
  {
    externalId: "k1-treatment",
    title: "Schedule K-1 Treatment Reference (SYNTHETIC SAMPLE)",
    text: "Box-level treatment positions for Schedule K-1. Box 13 code W (other deductions) from an MLP is generally a section 212 portfolio deduction — confirm partnership footnotes before netting. Box 20 code Z reports section 199A qualified business income components. Unreimbursed partnership expenses (UPE) are deductible on Schedule E only when the partnership agreement requires the partner to bear them.",
  },
  {
    externalId: "1040-intake",
    title: "1040 Engagement Intake Checklist (SYNTHETIC SAMPLE)",
    text: "Intake checklist for a Form 1040 individual engagement. Send the client the Stanford Tax organizer, collect prior-year return, W-2s, 1099s, brokerage 1099-B/consolidated statements, K-1s, mortgage 1098, and property-tax records. Confirm dependents, filing status, and estimated-payment history. Do not begin preparation until the organizer is at least 80% complete and an engagement letter is signed.",
  },
  {
    externalId: "catchup-bookkeeping",
    title: "Catch-Up Bookkeeping Workflow (SYNTHETIC SAMPLE)",
    text: "Workflow for a catch-up bookkeeping engagement in QuickBooks Online. Import bank and credit-card feeds for the full catch-up period, apply the standard chart of accounts, categorize transactions using the client's vendor rules, reconcile every bank and credit-card account month by month, and produce a period-end balance sheet and profit-and-loss for review. Flag any month that cannot be reconciled for partner escalation.",
  },
  {
    externalId: "karbon-templates",
    title: "Karbon Work-Item Template Catalog (SYNTHETIC SAMPLE)",
    text: "Inventory of Karbon work-item templates. Templates: 1040 Individual Return, 1120-S S-Corp Return, 1065 Partnership Return, Monthly Bookkeeping, Catch-Up Bookkeeping, Quarterly Estimates, and BOI Filing. Each template defines the default work schedule, task checklist, assignee roles, and client-request set. Use the Catch-Up Bookkeeping template — not Monthly Bookkeeping — when onboarding a client whose books are more than one quarter behind.",
  },
  {
    externalId: "staff-onboarding",
    title: "New-Hire Week 1 Onboarding (SYNTHETIC SAMPLE)",
    text: "First-week onboarding for new preparers. Set up UltraTax, Karbon, QuickBooks Online Accountant, and SharePoint access. UPE means unreimbursed partnership expenses. Review the time-coding guide and record all time daily. Shadow a senior on one 1040 and one bookkeeping engagement before taking assigned work. Ask questions in the team channel; there are no dumb questions in week one.",
  },
];

/**
 * Positives: 20 questions phrased the way staff would actually ask them, each
 * labeled with the document(s) that genuinely answer it.
 *
 * Questions are worded to avoid quoting their source document verbatim. A
 * question that copies its answer's phrasing measures string matching, not
 * retrieval, and would score well even on a broken retriever.
 */
export const EVAL_QUESTIONS_CPA: EvalQuestion[] = [
  {
    id: "cpa-q01",
    query: "How soon must we file a BOI report for an LLC formed in 2024?",
    relevant: ["boi-filing"],
  },
  {
    id: "cpa-q02",
    query:
      "What identifying documents do we collect for each beneficial owner?",
    relevant: ["boi-filing"],
  },
  {
    id: "cpa-q03",
    query: "What time code do I use for a reviewer pass on a return?",
    relevant: ["time-coding"],
  },
  {
    id: "cpa-q04",
    query: "How should catch-up bookkeeping time be coded in Karbon?",
    relevant: ["time-coding"],
  },
  {
    id: "cpa-q05",
    query: "What is our position on K-1 box 13 code W from an MLP?",
    relevant: ["k1-treatment"],
  },
  {
    id: "cpa-q06",
    query: "Where does box 20 code Z on a K-1 get reported?",
    relevant: ["k1-treatment"],
  },
  {
    id: "cpa-q07",
    query: "What documents does the 1040 intake checklist require?",
    relevant: ["1040-intake"],
  },
  {
    id: "cpa-q08",
    query: "How complete must the organizer be before we start a 1040?",
    relevant: ["1040-intake"],
  },
  {
    id: "cpa-q09",
    query: "What are the steps for a catch-up bookkeeping engagement in QBO?",
    relevant: ["catchup-bookkeeping"],
  },
  {
    id: "cpa-q10",
    query: "When do I escalate a bookkeeping month to a partner?",
    relevant: ["catchup-bookkeeping"],
  },
  {
    id: "cpa-q11",
    query:
      "Which Karbon template do I use for a client a year behind on books?",
    relevant: ["karbon-templates"],
  },
  {
    id: "cpa-q12",
    query: "Is there a Karbon template for BOI filings?",
    relevant: ["karbon-templates"],
  },
  {
    id: "cpa-q13",
    query: "What does UPE stand for?",
    relevant: ["staff-onboarding", "k1-treatment"],
  },
  {
    id: "cpa-q14",
    query: "What systems do I need set up in my first week?",
    relevant: ["staff-onboarding"],
  },
  {
    id: "cpa-q15",
    query: "When can UPE be deducted on Schedule E?",
    relevant: ["k1-treatment"],
  },
  {
    id: "cpa-q16",
    query: "What organizer do we send clients for individual returns?",
    relevant: ["1040-intake"],
  },
  {
    id: "cpa-q17",
    query: "How do I reconcile accounts during a catch-up engagement?",
    relevant: ["catchup-bookkeeping"],
  },
  {
    id: "cpa-q18",
    query: "What code is advisory and tax-planning work billed under?",
    relevant: ["time-coding"],
  },
  {
    id: "cpa-q19",
    query: "Do I need to report company applicants for a 2024 entity?",
    relevant: ["boi-filing"],
  },
  {
    id: "cpa-q20",
    query:
      "Which template lists the default task checklist for a partnership return?",
    relevant: ["karbon-templates"],
  },
];

// Out-of-corpus: nothing here should be answered with a confident citation.
/**
 * Negatives: plausible CPA questions that this corpus genuinely cannot answer.
 * `relevant: []` is the assertion — the correct behavior is to retrieve nothing
 * worth citing and, downstream, to decline rather than improvise.
 *
 * Scored inversely to the positives: a hit here is a FAILURE. Standard
 * recall/precision cannot express that, which is why these live in their own
 * export rather than mixed into `EVAL_QUESTIONS_CPA` — averaging them together
 * would let a confident wrong answer cancel out a correct one.
 */
export const EVAL_NEGATIVES_CPA: EvalQuestion[] = [
  {
    id: "cpa-n01",
    query:
      "How do I compute the research and development tax credit on Form 6765?",
    relevant: [],
  },
  {
    id: "cpa-n02",
    query: "What is the depreciation schedule for a solar energy investment?",
    relevant: [],
  },
  {
    id: "cpa-n03",
    query: "How do we handle a like-kind 1031 exchange of real property?",
    relevant: [],
  },
  {
    id: "cpa-n04",
    query: "What is the firm's policy on cryptocurrency staking income?",
    relevant: [],
  },
  {
    id: "cpa-n05",
    query: "How do I file an FBAR for foreign bank accounts?",
    relevant: [],
  },
  {
    id: "cpa-n06",
    query: "What is the mileage rate for the current tax year?",
    relevant: [],
  },
  {
    id: "cpa-n07",
    query: "How do I set up a defined-benefit pension plan for a client?",
    relevant: [],
  },
  {
    id: "cpa-n08",
    query:
      "What is our approach to state apportionment for multistate corporations?",
    relevant: [],
  },
];
