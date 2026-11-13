/**
 * `HttpError` lives in `@saas/shared` so `@saas/core` can raise one without
 * importing from the API that hosts it. This re-export is the seam: every
 * service keeps importing from here, and no call site churned when it moved.
 */
export { HttpError, badRequest, conflict, notFound, tooLarge } from "@saas/shared";
