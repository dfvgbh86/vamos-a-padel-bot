/** Polls `check` until it returns a value other than undefined; fails with `what` after `timeoutMs` of real time. */
export const waitFor = async <T>(what: string, check: () => T | undefined, timeoutMs: number, everyMs = 25): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = check();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, everyMs));
  }
};

export const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
