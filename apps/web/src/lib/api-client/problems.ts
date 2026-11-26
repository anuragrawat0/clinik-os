const messages: Readonly<Record<string, string>> = {
  FORBIDDEN: 'You don’t have permission to do that.',
  NOT_FOUND: 'This item could not be found or is no longer available.',
  BRANCH_INACTIVE: 'Reactivate this branch before assigning staff.',
  INVITATION_PENDING: 'An invitation for this email and role is already pending.',
  ALREADY_HAS_ROLE: 'This person already has that role.',
  OWNER_EXISTS: 'This clinic already has an owner.',
  ORG_SLUG_TAKEN: 'That clinic URL is already in use.',
  BRANCH_CODE_TAKEN: 'That branch code is already in use in this clinic.',
  INVALID_TIMEZONE: 'Choose a supported time zone.',
  INVALID_PASSWORD: 'The current password is incorrect.',
  INVALID_CREDENTIALS: 'Unable to sign in. Check your email and password.',
  SELF_GRANT_FORBIDDEN: 'You cannot change your own roles.',
  EMPTY_ROLES: 'Keep at least one role or use Remove to remove this member from the clinic.',
  RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
  UNAUTHENTICATED: 'Your session ended. Sign in again to continue.',
  VALIDATION_ERROR: 'Check the fields and try again.',
  INVALID_REQUEST: 'Check the fields and try again.',
  INVALID_CURSOR: 'This page is no longer available. Refresh and try again.',
  PASSWORD_TOO_SHORT: 'Use at least 12 characters.',
  PASSWORD_TOO_LONG: 'Use no more than 128 characters.',
  PASSWORD_TOO_COMMON: 'Choose a less common password.',
  PASSWORD_CONTAINS_EMAIL: 'Choose a password that does not contain your email.',
};

export const sessionEndedPath = '/login?reason=session-ended';

class ApiProblem extends Error {}

export function displayError(error: unknown): string {
  return error instanceof ApiProblem ? error.message : problemMessage(undefined);
}

export function problemMessage(
  error: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code] : fallback;
}

export function checkResponse(response: Response, error: unknown): void {
  if (!response.ok) {
    throw new ApiProblem(
      problemMessage(error, response.status === 401 ? messages.UNAUTHENTICATED : undefined),
    );
  }
}

export function responseData<T>({
  data,
  response,
  error,
}: {
  data?: T;
  response: Response;
  error?: unknown;
}): T {
  checkResponse(response, error);
  if (data === undefined) throw new ApiProblem('The server did not return the information needed.');
  return data;
}
