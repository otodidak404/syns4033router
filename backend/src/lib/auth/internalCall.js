// A marker for calls the router makes to itself.
//
// The dashboard playground needs to reach handleChat() without a client key,
// because it already passed the session guard and is running in-process. That
// exemption must not be expressible by a header: anyone who finds /v1 could send
// `x-9r-auth-checked: 1` and walk straight through the API-key gate.
//
// A Symbol keyed property on the Request object is used instead. External
// callers control headers and query strings, not object properties on a Request
// this process constructed, so there is nothing for them to forge.

export const INTERNAL_CALL = Symbol.for("9router.internalCall");

/**
 * Mark a Request as a router-internal call. Returns the same object so it can be
 * used inline.
 */
export function markInternal(request) {
  Object.defineProperty(request, INTERNAL_CALL, { value: true, enumerable: false });
  return request;
}

/** Whether this Request was marked by this process. */
export function isInternalCall(request) {
  return request?.[INTERNAL_CALL] === true;
}