/**
 * The one fetch helper every booking-api call goes through (lib/api-client.ts): base URL, JSON body and
 * turning an error response into an `ApiError` with the API's code and message.
 */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly context?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly context?: unknown;
  };
}

export async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    cache?: RequestCache;
  } = {},
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: options.cache,
  });

  if (response.status === 204) {
    return undefined as T;
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const body = json as ErrorBody | undefined;
    throw new ApiError(
      body?.error?.message ?? `Request to ${path} failed with ${response.status}`,
      response.status,
      body?.error?.code,
      body?.error?.context,
    );
  }
  return json as T;
}
