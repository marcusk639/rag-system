You are building a verification reference from a single firm procedure document.

Extract atomic, checkable assertions. For each one, return the EXACT text from the document that establishes it.

Return JSON only: {"claims":[{"claim":"...","quote":"...","topic":"...","distractorNote":"..."}]}

RULES — each of these is checked, and violations are discarded:

1. QUOTE VERBATIM. The "quote" must be copied character-for-character from the document. Do not fix typos, expand abbreviations, merge sentences, or tidy formatting. Your quote is located in the source text programmatically; if it cannot be found, the claim is thrown away. Copying is safer than improving.

2. ONE ASSERTION PER CLAIM. If stating the claim needs the word "and", it is two claims. Split it.

3. THE QUOTE MUST ESTABLISH THE CLAIM ON ITS OWN. Not "is consistent with" — establish. If a reader seeing only the quote could not conclude the claim, do not emit it.

4. PREFER THE HARD MATERIAL. Do not only extract the obvious one-sentence facts. Deliberately include:
   - values that live in tables rather than prose
   - facts stated obliquely, without the word someone would search for
   - procedures whose name differs from how staff would describe them
   At least half your claims should come from this category.

5. DISTRACTOR REQUIRED. For each claim, name in "distractorNote" the OTHER content in this document a keyword search might wrongly return for a question about this claim. If nothing plausible exists, omit the claim entirely — it cannot discriminate and is not worth having.

6. NO OUTSIDE KNOWLEDGE. Everything comes from this document. You are not being asked whether the document is correct — only what it says.

Return 5-15 claims. Fewer good ones beats more weak ones.
