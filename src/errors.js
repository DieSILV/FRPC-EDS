/**
 * Error con código HTTP asociado, para respuestas consistentes de la API.
 */
export function httpError(status, message, details) {
  const err = new Error(message);
  err.status = status;
  if (details !== undefined) err.details = details;
  return err;
}
