import { describe, expect, it } from 'vitest';
import {
  contentAfter,
  decodeEntities,
  findTags,
  htmlToText,
  MAX_HTML_LENGTH,
  readAttributes,
  visibleMarkup,
} from '../../src/reservaplay/parsers/html.js';
import { parseCsrfToken, parseGuestPrices } from '../../src/reservaplay/parsers/index.js';
import { CSRF_TOKEN } from '../fixtures/reservaplay/constants.js';

describe('readAttributes', () => {
  it('keeps the first occurrence of a repeated attribute, as a browser does', () => {
    const attributes = readAttributes('<input name="first" value="a" name="second" VALUE="b">');
    expect(attributes.get('name')).toBe('first');
    expect(attributes.get('value')).toBe('a');
    expect(attributes.size).toBe(2);
  });

  it('lets the first occurrence decide what a parser sees', () => {
    expect(parseCsrfToken(`<input name="_token" value="${CSRF_TOKEN}" value="other-token-0002">`)).toBe(CSRF_TOKEN);
    expect(parseCsrfToken(`<input name="other" name="_token" value="${CSRF_TOKEN}">`)).toBeNull();
    expect(parseCsrfToken(`<input name="_token" name="other" value="${CSRF_TOKEN}">`)).toBe(CSRF_TOKEN);
  });

  it('lower-cases names, decodes entities in values and maps boolean attributes to the empty string', () => {
    const attributes = readAttributes(`<INPUT Type='radio' DISABLED value=a&amp;b data-x = "1 &lt; 2" />`);
    expect(Object.fromEntries(attributes)).toEqual({ type: 'radio', disabled: '', value: 'a&b', 'data-x': '1 < 2' });
  });
});

describe('visibleMarkup and the size cap', () => {
  it('accepts a page of exactly the cap and rejects one character more', () => {
    expect(visibleMarkup('x'.repeat(MAX_HTML_LENGTH))).toHaveLength(MAX_HTML_LENGTH);
    expect(visibleMarkup('x'.repeat(MAX_HTML_LENGTH + 1))).toBeNull();
    expect(htmlToText('x'.repeat(MAX_HTML_LENGTH + 1))).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const value of [undefined, null, 5, {}, ['<p>']]) expect(visibleMarkup(value)).toBeNull();
  });

  it('removes comments, scripts and styles, whatever the case, and swallows an unterminated one', () => {
    expect(visibleMarkup('a<!-- x -->b<SCRIPT>y</Script>c<Style>z</STYLE>d')).toBe('abcd');
    expect(visibleMarkup('a<script>never closed')).toBe('a');
  });
});

describe('contentAfter', () => {
  const markup = '<ul id="l"><li id="1">one<li id="2">two</LI><li id="3">three</ul>tail';
  const first = (name: string, id: string) => findTags(markup, name).find((tag) => tag.attributes.get('id') === id)!;

  it('returns the markup up to the nearest terminator', () => {
    expect(contentAfter(markup, first('li', '1'), '</li', '<li')).toBe('one');
    expect(contentAfter(markup, first('ul', 'l'), '</ul')).toBe('<li id="1">one<li id="2">two</LI><li id="3">three');
  });

  it('matches terminators in any case and picks the earliest of several', () => {
    expect(contentAfter(markup, first('li', '2'), '</li', '<li')).toBe('two');
    expect(contentAfter(markup, first('li', '2'), '<li', '</li')).toBe('two');
    expect(contentAfter(markup, first('li', '3'), '</LI', '</UL')).toBe('three');
  });

  it('runs to the end when there is no terminator, or none was given', () => {
    expect(contentAfter(markup, first('li', '3'), '</li')).toBe('three</ul>tail');
    expect(contentAfter(markup, first('li', '3'))).toBe('three</ul>tail');
  });

  it('never looks before the tag it starts from', () => {
    expect(contentAfter(markup, first('li', '3'), '<li')).toBe('three</ul>tail');
  });

  it('treats regular-expression characters in a terminator literally', () => {
    const text = '<p id="a">x.y*z</p>(end)';
    expect(contentAfter(text, findTags(text, 'p')[0]!, '(end)')).toBe('x.y*z</p>');
    expect(contentAfter(text, findTags(text, 'p')[0]!, '.')).toBe('x');
    expect(contentAfter(text, findTags(text, 'p')[0]!, 'z</p>|')).toBe('x.y*z</p>(end)');
  });

  it('is not fooled by non-ASCII letters that fold onto ASCII ones', () => {
    const dotless = '<li id="1">a<lı>b';
    expect(contentAfter(dotless, findTags(dotless, 'li')[0]!, '<li')).toBe('a<lı>b');
    const longS = '<li id="1">a</ſtrong>b';
    expect(contentAfter(longS, findTags(longS, 'li')[0]!, '</strong')).toBe('a</ſtrong>b');
  });
});

describe('findTags', () => {
  it('stops after the requested number of tags', () => {
    const markup = '<li id="1"><li id="2"><li id="3"><li id="4">';
    expect(findTags(markup, 'li', 2).map((tag) => tag.attributes.get('id'))).toEqual(['1', '2']);
    expect(findTags(markup, 'li', 0)).toEqual([]);
    expect(findTags(markup, 'li')).toHaveLength(4);
  });

  it('does not take a longer tag name for the one it looks for', () => {
    expect(findTags('<link href="x"><li id="1"><LI id="2">', 'li').map((tag) => tag.attributes.get('id'))).toEqual(['1', '2']);
  });
});

describe('decodeEntities', () => {
  it('decodes the known references and neutralises the impossible ones', () => {
    expect(decodeEntities('&amp;&euro;&#8364;&#x20AC;')).toBe('&€€€');
    expect(decodeEntities('&unknown;')).toBe('&unknown;');
    expect(decodeEntities('a&#0;b&#xD800;c&#1114112;d')).toBe('a b c d');
  });
});

describe('guest prices written the way PHP json_encode writes them', () => {
  it('decodes escaped euro signs and slashes before looking for prices', () => {
    const body = '{"error":false,"view":"<ul><li>Invitado Invitado - 5.34\\u20ac<\\/li><li>Invitado Invitado - 4,00 \\u20ac<\\/li><\\/ul>"}';
    expect(body).toContain('\\u20ac');
    expect(body).toContain('<\\/li>');
    expect(parseGuestPrices(body)).toEqual([534, 400]);
  });

  it('would find nothing in the raw text, which is why the JSON has to be decoded', () => {
    const body = '{"view":"<li>Invitado Invitado - 5.34\\u20ac<\\/li>"}';
    expect(htmlToText(body)).not.toContain('€');
    expect(parseGuestPrices(body)).toEqual([534]);
  });

  it('decodes escaped quotes and newlines too', () => {
    const body = '{"view":"<div class=\\"x\\">\\n  Invitado Invitado -\\n 5.34 \\u20ac\\n<\\/div>"}';
    expect(parseGuestPrices(body)).toEqual([534]);
  });
});
