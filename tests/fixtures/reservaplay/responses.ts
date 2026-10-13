export interface ResponseOptions {
  readonly status?: number;
  /** Raw Set-Cookie header values. */
  readonly cookies?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
}

const build = (body: string | null, contentType: string, options: ResponseOptions): Response => {
  const headers = new Headers({ 'content-type': contentType, ...options.headers });
  for (const cookie of options.cookies ?? []) headers.append('set-cookie', cookie);
  return new Response(body, { status: options.status ?? 200, headers });
};

export const htmlResponse = (html: string, options: ResponseOptions = {}): Response =>
  build(html, 'text/html; charset=UTF-8', options);

export const jsonResponse = (value: unknown, options: ResponseOptions = {}): Response =>
  build(JSON.stringify(value), 'application/json', options);

export const textResponse = (text: string, options: ResponseOptions = {}): Response => build(text, 'text/plain', options);

export const redirectResponse = (location: string, options: ResponseOptions = {}): Response =>
  build(null, 'text/html', { ...options, status: options.status ?? 302, headers: { location, ...options.headers } });

export const emptyResponse = (status: number, options: ResponseOptions = {}): Response =>
  new Response(null, { status, headers: options.headers });
