export async function withExponentialBackoff<T>(
  fn: () => Promise<T>,
  options: { maxAttempts: number; initialDelayMs: number; label?: string },
): Promise<T> {
  let lastErr: unknown;
  let delay = options.initialDelayMs;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === options.maxAttempts) break;
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  throw lastErr;
}
