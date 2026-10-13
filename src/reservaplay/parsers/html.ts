/** Real pages are ~90 KB; anything far beyond that is not a page we understand. */
export const MAX_HTML_LENGTH = 2_000_000;

const ENTITIES: Readonly<Record<string, string>> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  euro: '€',
};

const MAX_CODE_POINT = 0x10ffff;

const isSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdfff;

export const decodeEntities = (text: string): string =>
  text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (!body.startsWith('#')) return ENTITIES[body.toLowerCase()] ?? whole;
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= MAX_CODE_POINT && !isSurrogate(code) ? String.fromCodePoint(code) : ' ';
  });

/** ASCII-only lower-casing never changes the string length, so indices stay valid. */
const asciiLower = (source: string): string => source.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));

/** Removes `open ... close` blocks in linear time; an unterminated block swallows the rest, as a browser would. */
const removeBlocks = (source: string, open: string, close: string): string => {
  const lower = asciiLower(source);
  const parts: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = lower.indexOf(open, cursor);
    if (start === -1) {
      parts.push(source.slice(cursor));
      break;
    }
    parts.push(source.slice(cursor, start));
    const end = lower.indexOf(close, start + open.length);
    if (end === -1) break;
    cursor = end + close.length;
  }
  return parts.join('');
};

/** The markup a browser would render: comments, scripts and styles removed. Null when the input is not a sane page. */
export const visibleMarkup = (html: unknown): string | null => {
  if (typeof html !== 'string' || html.length > MAX_HTML_LENGTH) return null;
  return removeBlocks(removeBlocks(removeBlocks(html, '<!--', '-->'), '<script', '</script>'), '<style', '</style>');
};

/** Linear: `[^<>]*` cannot run past the next angle bracket. */
export const stripTags = (markup: string): string => markup.replace(/<[^<>]*>/g, ' ');

const collapseSpace = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Visible text of a page or fragment: tags replaced by spaces, entities decoded, whitespace collapsed. */
export const htmlToText = (html: unknown): string | null => {
  const markup = visibleMarkup(html);
  return markup === null ? null : collapseSpace(decodeEntities(stripTags(markup)));
};

/** Lower-cased, accent-free text for matching site wording regardless of accents and case. */
export const normalizeText = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();

export interface Tag {
  readonly raw: string;
  readonly index: number;
  readonly attributes: ReadonlyMap<string, string>;
}

const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Attribute names are lower-cased, boolean attributes map to ''. The first occurrence of a name wins. */
export const readAttributes = (tag: string): ReadonlyMap<string, string> => {
  const inner = tag.replace(/^<[^\s<>/]+/, '').replace(/\/?>$/, '');
  const attributes = new Map<string, string>();
  for (const match of inner.matchAll(ATTRIBUTE)) {
    const name = (match[1] ?? '').toLowerCase();
    if (name === '' || attributes.has(name)) continue;
    attributes.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return attributes;
};

/** The first `limit` opening tags called `name`; the scan stops there, so a hostile page cannot make the caller pay for the rest. */
export const findTags = (markup: string, name: string, limit = Number.POSITIVE_INFINITY): Tag[] => {
  const tags: Tag[] = [];
  for (const match of markup.matchAll(new RegExp(`<${name}\\b[^<>]*>`, 'gi'))) {
    if (tags.length >= limit) break;
    tags.push({ raw: match[0], index: match.index ?? 0, attributes: readAttributes(match[0]) });
  }
  return tags;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Markup after the opening tag up to the first terminator (or the end), for flat containers such as ul and li. The cost is
 * the distance to the terminator, not the size of the page (an ASCII-only case-insensitive match, as `asciiLower` does).
 */
export const contentAfter = (markup: string, tag: Tag, ...terminators: readonly string[]): string => {
  const start = tag.index + tag.raw.length;
  if (terminators.length === 0) return markup.slice(start);
  const pattern = new RegExp(terminators.map(escapeRegExp).join('|'), 'gi');
  pattern.lastIndex = start;
  return markup.slice(start, pattern.exec(markup)?.index);
};
