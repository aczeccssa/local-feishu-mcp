const SENSITIVE_KEY_PATTERN = /(authorization|token|secret|app_secret|password)/i;
const MAX_LOG_DEPTH = 4;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 500;

function sanitizeString(value: string): string {
  if (value.length <= MAX_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_LOG_DEPTH) {
    return '[Truncated]';
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
    };
  }

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map(item => sanitizeValue(item, depth + 1));
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_ARRAY_ITEMS);

    return Object.fromEntries(
      entries.map(([key, nestedValue]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeValue(nestedValue, depth + 1),
      ]),
    );
  }

  if (typeof value === 'string') {
    return sanitizeString(value);
  }

  return value;
}

function emit(method: 'log' | 'error', ...args: unknown[]): unknown[] {
  const sanitizedArgs = args.map(arg => sanitizeValue(arg));
  console[method](...sanitizedArgs);
  return sanitizedArgs;
}

export const Logger = {
  log: (...args: unknown[]) => emit('log', ...args),
  error: (...args: unknown[]) => emit('error', ...args),
};

export function sanitizeLogArgs(args: unknown[]): unknown[] {
  return args.map(arg => sanitizeValue(arg));
}
