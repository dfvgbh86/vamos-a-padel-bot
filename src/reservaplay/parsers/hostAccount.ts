import { contentAfter, findTags, htmlToText, normalizeText, visibleMarkup, type Tag } from './html.js';

const HOST_MARKER = '(anfitrion)';
const POSITIVE_INTEGER = /^[1-9]\d{0,15}$/;
/** A padel booking lists four participants; a page with far more items is not the form we know. */
const MAX_ITEMS_EXAMINED = 20;

const isHostItem = (item: Tag, markup: string): boolean => {
  const classes = (item.attributes.get('class') ?? '').split(/\s+/);
  if (classes.includes('msg-primary')) return true;
  const text = htmlToText(contentAfter(markup, item, '</li', '<li'));
  return text !== null && normalizeText(text).includes(HOST_MARKER);
};

/**
 * Account id of the host in a rendered booking form:
 * `<ul class="participants" id="socis-list"><li class="msg msg-primary" id="12345">name<strong> (Anfitrión)</strong></li>...`.
 * Only the host item counts (the guests carry the shared guest id); returns a strict positive safe integer or null.
 */
export const parseHostAccountId = (html: unknown): number | null => {
  const markup = visibleMarkup(html);
  if (markup === null) return null;

  const list = findTags(markup, 'ul').find((tag) => tag.attributes.get('id') === 'socis-list');
  if (list === undefined) return null;

  const listMarkup = contentAfter(markup, list, '</ul');
  const host = findTags(listMarkup, 'li', MAX_ITEMS_EXAMINED).find((item) => isHostItem(item, listMarkup));
  const id = host?.attributes.get('id');
  if (id === undefined || !POSITIVE_INTEGER.test(id)) return null;
  const numeric = Number(id);
  return Number.isSafeInteger(numeric) ? numeric : null;
};
