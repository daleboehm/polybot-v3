// Exponential backoff retry wrapper

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('retry');

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
  label = 'operation',
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < opts.maxRetries) {
        const delay = Math.min(
          opts.baseDelayMs * 2 ** attempt,
          opts.maxDelayMs ?? 30_000,
        );
        log.warn({ attempt: attempt + 1, maxRetries: opts.maxRetries, delay, error: lastError.message }, `${label} failed, retrying`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError!;
}
