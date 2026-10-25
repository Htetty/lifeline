/**
 * Display casing for text that callers and the extractor produce in lower case
 * ("the apartments on Camino de la Reina", "in the attic", "water rising fast").
 *
 * Only the first letter of a standalone label or sentence is raised, after any
 * leading spaces, quotes or brackets. Everything else is left as written, so
 * names, acronyms and the caller's own wording survive.
 */
export function capitalize(text: string): string;
export function capitalize(text: string | null | undefined): string | null | undefined;
export function capitalize(text: string | null | undefined) {
  if (!text) return text;
  return text.replace(/^([\s"'“‘(]*)(\p{Ll})/u, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

/** Capitalizes each part of a " · "-separated list of labels, e.g. "medical need · on a roof". */
export function capitalizeEach(parts: string[]) {
  return parts.map((part) => capitalize(part));
}
