// Colors follow the playground: warm dark, pink accent, amber secondary.
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};
const fg = (hex: string) => (s: string) => `\x1b[38;2;${rgb(hex)}m${s}\x1b[39m`;
const wrap = (on: string, off: string) => (s: string) => `\x1b[${on}m${s}\x1b[${off}m`;

export const c = {
  accent: fg("#ff8997"),
  muted: fg("#a08a74"),
  secondary: fg("#c9a87c"),
  text: fg("#f2eeee"),
  ok: fg("#6fcf97"),
  warn: fg("#f2c66d"),
  err: fg("#ff6b6b"),
  user: fg("#8ec5ff"),
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  italic: wrap("3", "23"),
  underline: wrap("4", "24"),
  strike: wrap("9", "29"),
  userBg: (s: string) => `\x1b[48;2;43;32;33m${s}\x1b[49m`,
};

export const markdownTheme: MarkdownTheme = {
  heading: (s) => c.bold(c.accent(s)),
  link: c.user,
  linkUrl: c.muted,
  code: c.secondary,
  codeBlock: c.text,
  codeBlockBorder: c.muted,
  quote: c.muted,
  quoteBorder: c.muted,
  hr: c.muted,
  listBullet: c.accent,
  bold: c.bold,
  italic: c.italic,
  strikethrough: c.strike,
  underline: c.underline,
};

export const selectTheme: SelectListTheme = {
  selectedPrefix: c.accent,
  selectedText: (s) => c.bold(c.accent(s)),
  description: c.muted,
  scrollInfo: c.muted,
  noMatch: c.muted,
};

export const editorTheme: EditorTheme = { borderColor: c.muted, selectList: selectTheme };
