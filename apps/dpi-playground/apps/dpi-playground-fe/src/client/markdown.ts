import { marked } from "marked";
import DOMPurify from "dompurify";

// Transcripts re-render on every stream frame; cache rendered blocks by their source text.
const cache = new Map<string, string>();
export function markdown(text: string) {
  let html = cache.get(text);
  if (html === undefined) {
    html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
    if (cache.size > 400) cache.delete(cache.keys().next().value!);
    cache.set(text, html);
  }
  return html;
}
