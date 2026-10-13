import { ACCOUNT_ID, CSRF_TOKEN, GUEST_PRICE_TEXT, HASH, HOST_NAME } from './constants.js';

/** 1902 -> "19.02": integer arithmetic only. */
export const formatCents = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

const page = (body: string): string =>
  `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Club</title>` +
  `<script>var settings = { debug: false };</script><style>.msg { color: red }</style></head><body>${body}</body></html>`;

export interface LoginPageOptions {
  readonly token?: string;
  /** `value` before `name`, as some templates render it. */
  readonly valueFirst?: boolean;
  readonly metaOnly?: boolean;
}

export const loginPageHtml = (options: LoginPageOptions = {}): string => {
  const token = options.token ?? CSRF_TOKEN;
  const hidden = options.valueFirst
    ? `<input type="hidden" value="${token}" name="_token">`
    : `<input type="hidden" name="_token" value="${token}">`;
  const meta = `<meta name="csrf_token" content="${token}">`;
  return (
    `<!DOCTYPE html><html><head>${options.metaOnly ? meta : ''}<title>Acceso</title></head><body>` +
    `<form method="POST" action="/login">${options.metaOnly ? '' : hidden}` +
    '<input type="text" name="username"><input type="password" name="password">' +
    '<button type="submit">Entrar</button></form></body></html>'
  );
};

export const closedWindowHtml = (serverTime = '12/10/2026 06:59:58'): string =>
  page(
    '<div class="msg msg-error">No se puede reservar a 8 o m&aacute;s dias vista.</div>' +
      `<p>Hora actual comprobación: ${serverTime}</p>`,
  );

export const dailyLimitHtml = (): string => page('<div class="msg msg-warning">Ya tienes 1 reserva/s para este dia.</div>');

export const tooShortHtml = (): string => page('<div class="msg">El tiempo de reserva mínimo es de 60 minutos</div>');

export interface OpenFormOptions {
  readonly hash?: string;
  readonly accountId?: number;
  readonly guests?: number;
}

export const openFormHtml = (options: OpenFormOptions = {}): string => {
  const guests = Array.from({ length: options.guests ?? 3 }, () => '<li class="msg msg-info" id="3">Invitado</li>').join('');
  return page(
    '<div class="panel"><form id="event-form" method="post" action="manager.php">' +
      `<input type="hidden" name="hash" value="${options.hash ?? HASH}">` +
      '<input type="hidden" name="op" value="add_event">' +
      '<ul class="participants" id="socis-list">' +
      `<li class="msg msg-primary" id="${options.accountId ?? ACCOUNT_ID}">${HOST_NAME}<strong> (Anfitrión)</strong></li>` +
      `${guests}</ul></form></div>`,
  );
};

export const walletPageHtml = (cents: number): string =>
  page(`<div class="monedero"><p>Actualmente dispones de <strong>${formatCents(cents)} €</strong> en tu monedero virtual</p></div>`);

export interface PaymentOptionsInit {
  readonly walletPayable?: boolean;
  readonly hostPriceCents?: number | null;
  readonly error?: boolean;
}

export const paymentOptionsPayload = (options: PaymentOptionsInit = {}): Record<string, unknown> => {
  const price = options.hostPriceCents === undefined ? 300 : options.hostPriceCents;
  const view =
    '<div class="pago-anticipado">' +
    (price === null ? '' : `<p>Precio reserva: ${formatCents(price)} €</p>`) +
    '<label><input type="radio" name="tipo_pago_anticipado_socio" value="2" checked> Tarjeta</label>' +
    `<label><input type="radio" name="tipo_pago_anticipado_socio" value="5"${options.walletPayable === false ? ' disabled="disabled"' : ''}> Monedero virtual</label>` +
    '</div>';
  return { error: options.error ?? false, error_msg: '', hay_precio: price === null ? 0 : 1, view };
};

export const guestInfoPayload = (prices: readonly string[] = [GUEST_PRICE_TEXT, GUEST_PRICE_TEXT, GUEST_PRICE_TEXT]): Record<string, unknown> => ({
  error: false,
  view: `<ul>${prices.map((price) => `<li>Invitado Invitado - ${price}€</li>`).join('')}</ul>`,
});

export const bookingOkPayload = (reservationId: number): Record<string, unknown> => ({
  status: 'ok',
  data: {
    msg: 'Gracias para añadir una reserva, su reserva ya ha sido publicada<br/>',
    redirect: { url: `cal_event.php?id=${reservationId}`, wait: 0, title: 'Ficha reserva' },
  },
});

export const bookingErrorPayload = (message: string): Record<string, unknown> => ({ status: 'error', data: { msg: message } });

export const cancelOkPayload = (): Record<string, unknown> => ({
  status: 'ok',
  data: { msg: 'Su reserva ha sido cancelada.', redirect: { url: 'cal_week.php', wait: 0 } },
});
