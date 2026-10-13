const NUMERIC_SEPARATOR_SOURCE = String.raw`(?:\s*,\s*|\s*\{\s*,\s*\}\s*|\s*\\,\s*)`;
const COMMA_CONNECTED_NUMERIC_TOKEN = new RegExp(
  String.raw`\d+(?:${NUMERIC_SEPARATOR_SOURCE}\d+)+`,
  "g"
);
const VALID_GROUPED_NUMERIC_TOKEN = new RegExp(
  String.raw`^\d{1,3}(?:${NUMERIC_SEPARATOR_SOURCE}\d{3})+$`
);
const NUMERIC_GROUP_SEPARATOR = new RegExp(NUMERIC_SEPARATOR_SOURCE, "g");

/**
 * Converts presentation-level thousands separators inside numeric tokens to
 * the canonical internal form. Structural commas, such as coordinate and list
 * separators, are preserved.
 */
export function canonicalizeNumericTokens(text: string) {
  return text.replace(COMMA_CONNECTED_NUMERIC_TOKEN, (token) =>
    VALID_GROUPED_NUMERIC_TOKEN.test(token)
      ? token.replace(NUMERIC_GROUP_SEPARATOR, "")
      : token
  );
}
