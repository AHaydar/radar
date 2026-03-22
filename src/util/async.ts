/**
 * Race a promise against a timeout. Cancels the timer when the promise settles,
 * preventing dangling timer handles in long-running processes.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timerId = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
}
