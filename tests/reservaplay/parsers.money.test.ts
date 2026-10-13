import { describe, expect, it } from 'vitest';
import { parseMoneyCents, parseWalletCents } from '../../src/reservaplay/parsers/index.js';
import { formatCents, walletPageHtml } from '../fixtures/reservaplay/pages.js';

describe('parseMoneyCents', () => {
  it.each([
    ['19.02', 1902],
    ['19,02', 1902],
    ['19', 1900],
    ['0', 0],
    ['0.00', 0],
    ['0,5', 50],
    ['3.0', 300],
    ['5.34', 534],
    ['0.07', 7],
    ['1.15', 115],
    ['1000.00', 100000],
    ['1.234,56', 123456],
    ['1,234.56', 123456],
    ['12.345.678,90', 1234567890],
    ['1,234,567.89', 123456789],
    ['  19.02  ', 1902],
  ])('parses %j as %i cents', (text, cents) => {
    expect(parseMoneyCents(text)).toBe(cents);
  });

  it.each([
    '',
    ' ',
    'abc',
    '19.0.2',
    '19..02',
    '19.021',
    '19.',
    '.5',
    ',5',
    '-1',
    '+1',
    '1e3',
    '1 000',
    '19,02,5',
    '1,23,456',
    '1.234',
    '19.021',
    '12.345.678',
    '1.234.56',
    '1,234,56',
    '0x10',
    '19.02 €',
    '999999999999999999999999',
    '1.234.567.890.123.456,00',
  ])('rejects %j', (text) => {
    expect(parseMoneyCents(text)).toBeNull();
  });

  it('round-trips every amount from 0.00 to 300.00 exactly (no floating point drift)', () => {
    for (let cents = 0; cents <= 30_000; cents += 1) {
      expect(parseMoneyCents(formatCents(cents))).toBe(cents);
      expect(parseMoneyCents(formatCents(cents).replace('.', ','))).toBe(cents);
    }
  });
});

describe('parseWalletCents', () => {
  it.each([
    ['Actualmente dispones de 19.02 € en tu monedero virtual', 1902],
    ['Actualmente dispones de 19,02 € en tu monedero virtual', 1902],
    ['Actualmente dispones de 19.02€ en tu monedero virtual', 1902],
    ['Actualmente dispones de 0.00 € en tu monedero virtual', 0],
    ['Actualmente dispones de 1.234,50 € en tu monedero virtual', 123450],
    ['actualmente DISPONES de 19.02 EUR en tu Monedero Virtual', 1902],
    ['<p>Actualmente dispones de <strong>19.02 €</strong> en tu monedero virtual</p>', 1902],
    ['<p>Actualmente   dispones\n de 19.02&nbsp;&euro; en   tu monedero\tvirtual.</p>', 1902],
    ['<p>Actualmente dispones de 19.02 &#8364; en tu monedero virtual</p>', 1902],
  ])('reads %j', (html, cents) => {
    expect(parseWalletCents(html)).toBe(cents);
  });

  it('reads the balance from a full page', () => {
    expect(parseWalletCents(walletPageHtml(1902))).toBe(1902);
    expect(parseWalletCents(walletPageHtml(7))).toBe(7);
    expect(parseWalletCents(walletPageHtml(0))).toBe(0);
  });

  it.each([
    ['the sentence is missing', '<p>Bienvenido</p>'],
    ['the amount is not a number', 'Actualmente dispones de abc € en tu monedero virtual'],
    ['the amount is negative', 'Actualmente dispones de -3.00 € en tu monedero virtual'],
    ['the amount is garbled', 'Actualmente dispones de 19.0.2 € en tu monedero virtual'],
    ['the amount has three decimals', 'Actualmente dispones de 19.021 € en tu monedero virtual'],
    ['there is no amount', 'Actualmente dispones de € en tu monedero virtual'],
    ['the currency is missing', 'Actualmente dispones de 19.02 en tu monedero virtual'],
    ['the wallet is not mentioned', 'Actualmente dispones de 19.02 € en tu cuenta'],
    ['the input is empty', ''],
  ])('returns null when %s', (_name, html) => {
    expect(parseWalletCents(html)).toBeNull();
  });

  it('ignores the sentence inside scripts, styles and comments', () => {
    const decoy = 'Actualmente dispones de 99.99 € en tu monedero virtual';
    const html = `<script>var t = "${decoy}";</script><style>/* ${decoy} */</style><!-- ${decoy} -->${walletPageHtml(1902)}`;
    expect(parseWalletCents(html)).toBe(1902);
    expect(parseWalletCents(`<script>${decoy}</script>`)).toBeNull();
  });

  it('is not fooled by markup that merely looks like the sentence', () => {
    expect(parseWalletCents('<p title="Actualmente dispones de 5.00 € en tu monedero virtual">x</p>')).toBeNull();
  });

  it('rejects non-string and oversized input without hanging', () => {
    expect(parseWalletCents(undefined)).toBeNull();
    expect(parseWalletCents(null)).toBeNull();
    expect(parseWalletCents(42)).toBeNull();
    const started = performance.now();
    expect(parseWalletCents(`${'<'.repeat(3_000_000)}`)).toBeNull();
    expect(parseWalletCents(`Actualmente dispones de ${'9'.repeat(1_000_000)} € en tu monedero`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});
