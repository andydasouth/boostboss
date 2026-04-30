/**
 * Stable error codes — see /docs/npm-sdk#error-handling.
 */
export const ERROR_CODES = {
  AUTH:         "BBX_AUTH",
  RATE_LIMIT:   "BBX_RATE_LIMIT",
  TIMEOUT:      "BBX_TIMEOUT",
  NETWORK:      "BBX_NETWORK",
  BAD_RESPONSE: "BBX_BAD_RESPONSE",
  BAD_REQUEST:  "BBX_BAD_REQUEST",
  NO_DOM:       "BBX_NO_DOM",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return ERROR_CODES.AUTH;
  if (status === 429)                   return ERROR_CODES.RATE_LIMIT;
  return ERROR_CODES.BAD_RESPONSE;
}
