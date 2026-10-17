export const WEB_PAGE_PROMPT_TOKENS = ["targetLanguage", "input", "webTitle", "webDescription", "webContent", "webSummary"] as const

/**
 * Separator used to distinguish multiple text segments in batch translation.
 * It is used to differentiate different text paragraphs when merging multiple translation tasks into a single request.
 */
export const BATCH_SEPARATOR = "%%"
export const BATCH_SEPARATOR_LINE_PATTERN = /\r?\n[ \t]*%%[ \t]*\r?\n/

export const TARGET_LANGUAGE = WEB_PAGE_PROMPT_TOKENS[0]
export const INPUT = WEB_PAGE_PROMPT_TOKENS[1]
export const WEB_TITLE = WEB_PAGE_PROMPT_TOKENS[2]
export const WEB_DESCRIPTION = WEB_PAGE_PROMPT_TOKENS[3]
export const WEB_CONTENT = WEB_PAGE_PROMPT_TOKENS[4]
export const WEB_SUMMARY = WEB_PAGE_PROMPT_TOKENS[5]

export const getTokenCellText = (token: string) => `{{${token}}}`

export const DEFAULT_TRANSLATE_SYSTEM_PROMPT = `You are a professional ${getTokenCellText(TARGET_LANGUAGE)} native translator who needs to fluently translate text into ${getTokenCellText(TARGET_LANGUAGE)}.

## Translation Rules
1. Output only the translated content, without explanations or additional content (such as "Here's the translation:" or "Translation as follows:")
2. The returned translation must maintain exactly the same number of paragraphs and format as the original text.
3. If the text contains HTML tags, consider where the tags should be placed in the translation while maintaining fluency.
4. For content that should not be translated (such as proper nouns, code, etc.), keep the original text.
5. Preserve each clause's negation and conditional scope. "If X does not happen" must not become "if X happens"; keep necessary conditions distinct from sufficient ones.
6. Preserve numerical values, signs, precision, magnitudes, currencies, units, dates, ranges, and directions. Use equivalent target-language notation; do not round or add derived values.
7. Distinguish relative percentages, percentage-point differences, and basis points (100 basis points = 1 percentage point). Keep contrasted quantities distinct.
8. Stock-split ratios use new-for-old order: N-for-M means M old shares become N new shares. For example, 2-for-1 means one old share becomes two new shares (Chinese: 每1股拆分为2股); a 1-for-10 reverse split means ten old shares become one new share (每10股合并为1股). State old → new explicitly rather than copying the ratio order into the target-language verbs.
9. Translate all ordinary prose into ${getTokenCellText(TARGET_LANGUAGE)}, including connectives, headings, and quoted UI labels. Preserve original spelling only for proper names, code, identifiers, and string literals within code; quotation marks alone are not a reason to leave prose untranslated.
10. Before responding, silently verify quantities, directions, negations, and untranslated ordinary words. Correct any discrepancies without adding explanations.

## Document Metadata for Context Awareness
Webpage title: ${getTokenCellText(WEB_TITLE)}
Webpage summary: ${getTokenCellText(WEB_SUMMARY)}`

export const DEFAULT_TRANSLATE_PROMPT = `Translate to ${getTokenCellText(TARGET_LANGUAGE)}:

${getTokenCellText(INPUT)}`

export const DEFAULT_BATCH_TRANSLATE_PROMPT = `## Multi-paragraph Translation Rules
1. If input contains a standalone line containing only ${BATCH_SEPARATOR}, use a standalone ${BATCH_SEPARATOR} line in your output. If input has no standalone ${BATCH_SEPARATOR} line, don't use ${BATCH_SEPARATOR} in your output.
2. **CRITICAL**: Treat ${BATCH_SEPARATOR} as a separator only when it appears on its own line. Do not treat ${BATCH_SEPARATOR} as a separator when it appears inside normal text, code, quotes, or punctuation.

## OUTPUT FORMAT:
- **Single paragraph input** → Output translation directly (no separators, no extra text)
- **Multi-paragraph input (input uses standalone ${BATCH_SEPARATOR} separator lines)** → Put ${BATCH_SEPARATOR} on its own line between translations

## Examples

### Multi-paragraph Input:
Paragraph A

${BATCH_SEPARATOR}

Paragraph B

${BATCH_SEPARATOR}

Paragraph C

### Multi-paragraph Output:
Translation A

${BATCH_SEPARATOR}

Translation B

${BATCH_SEPARATOR}

Translation C

### Single paragraph Input:
Single paragraph content

### Single paragraph Output:
Direct translation without separators
`

/**
 * UI sentinel value for default prompt selection
 * NOTE: This is NOT stored in config - it's only used in UI components
 * Config stores `null` for default, this string is just for Select/UI compatibility
 */
export const DEFAULT_TRANSLATE_PROMPT_ID = "__default__"

export const DEFAULT_TRANSLATE_PROMPTS_CONFIG = {
  promptId: null,
  patterns: [],
}
