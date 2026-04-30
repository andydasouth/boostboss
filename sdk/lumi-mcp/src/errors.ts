/**
 * Stable error codes — see /docs/mcp#error-handling.
 * The SDK never throws on the bid path; failures resolve to null + an
 * "error" event with one of these codes.
 */
export const ERROR_CODES = {
  AUTH:        "BBX_AUTH",
  RATE_LIMIT:  "BBX_RATE_LIMIT",
  TIMEOUT:     "BBX_TIMEOUT",
  NO_FILL:     "BBX_NO_FILL",
  POLICY:      "BBX_POLICY",
  NETWORK:     "BBX_NETWORK",
  BAD_RESPONSE:"BBX_BAD_RESPONSE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Map an HTTP status to a stable error code. */
export function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return ERROR_CODES.AUTH;
  if (status === 429)                   return ERROR_CODES.RATE_LIMIT;
  if (status === 451)                   return ERROR_CODES.POLICY;
  return ERROR_CODES.BAD_RESPONSE;
}
