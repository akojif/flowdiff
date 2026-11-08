import { FlowdiffError } from '../errors.js';

/**
 * Base class for failures talking to n8n. Messages must never include the API key,
 * so none of these classes accept request headers.
 */
export class ApiError extends FlowdiffError {
  override name = 'ApiError';
}

export class UnreachableError extends ApiError {
  override name = 'UnreachableError';
}

export class ApiNotFoundError extends ApiError {
  override name = 'ApiNotFoundError';
}

export class InvalidApiKeyError extends ApiError {
  override name = 'InvalidApiKeyError';
}

export class ForbiddenError extends ApiError {
  override name = 'ForbiddenError';
}

export class UnexpectedResponseError extends ApiError {
  override name = 'UnexpectedResponseError';
}
