import { findTags, htmlToText, normalizeText, visibleMarkup } from './html.js';
import { AMOUNT_WITH_EURO, parseMoneyCents } from './money.js';
import { isPlainObject, isTruthyFlag } from './values.js';

export interface PaymentOptions {
  /** The "Monedero virtual" radio (value 5) exists and is not disabled, i.e. the credit is sufficient. */
  readonly walletPayable: boolean;
  /** Host share of the price ("Precio reserva: 3.00 €"), when the site shows it. */
  readonly hostPriceCents: number | null;
}

const PAYMENT_RADIO_NAME = 'tipo_pago_anticipado_socio';
const WALLET_RADIO_VALUE = '5';
const HOST_PRICE = new RegExp(`precio reserva\\s*:?\\s*${AMOUNT_WITH_EURO}`);

const hostPriceCents = (view: string): number | null => {
  const text = htmlToText(view);
  const amount = text === null ? undefined : HOST_PRICE.exec(normalizeText(text))?.[1];
  return amount === undefined ? null : parseMoneyCents(amount);
};

/**
 * `GET .../pago_anticipado_select/...` answers `{ error, error_msg, hay_precio, view }`; `view` is an HTML fragment with the
 * payment radios. Null when the answer is an error or does not contain the payment radios at all.
 */
export const parsePaymentOptions = (payload: unknown): PaymentOptions | null => {
  if (!isPlainObject(payload) || isTruthyFlag(payload['error'])) return null;
  const view = payload['view'];
  if (typeof view !== 'string') return null;
  const markup = visibleMarkup(view);
  if (markup === null) return null;

  const radios = findTags(markup, 'input').filter(
    (input) =>
      input.attributes.get('name') === PAYMENT_RADIO_NAME && (input.attributes.get('type') ?? 'radio').toLowerCase() === 'radio',
  );
  if (radios.length === 0) return null;

  const wallet = radios.find((radio) => radio.attributes.get('value') === WALLET_RADIO_VALUE);
  return {
    walletPayable: wallet !== undefined && !wallet.attributes.has('disabled'),
    hostPriceCents: hostPriceCents(view),
  };
};
