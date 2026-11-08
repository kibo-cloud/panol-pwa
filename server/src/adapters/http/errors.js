// Errores HTTP con un código estable (para el cliente) y un mensaje para mostrar al usuario.
export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (message, code = 'invalid_request') => new HttpError(400, code, message);
export const unauthorized = (message = 'Tenés que iniciar sesión.', code = 'unauthenticated') => new HttpError(401, code, message);
export const forbidden = (message = 'Tu perfil no tiene permiso para esta acción.', code = 'forbidden') => new HttpError(403, code, message);
export const notFound = (message = 'No se encontró el registro.', code = 'not_found') => new HttpError(404, code, message);
export const conflict = (message, code = 'conflict') => new HttpError(409, code, message);

// Manejador común: nunca expone detalles internos (stack, SQL) al cliente.
export function errorHandler(err, req, reply) {
  if (err instanceof HttpError) {
    return reply.code(err.status).send({ error: err.code, message: err.message, ...err.extra });
  }
  if (err && err.name === 'DomainError') {
    const body = { error: err.code, message: err.message, ...(err.extra || {}) };
    if (err.retryAfter) {
      reply.header('Retry-After', String(err.retryAfter));
      body.retryAfter = err.retryAfter;
    }
    return reply.code(err.status || 422).send(body);
  }
  if (err && err.validation) {
    return reply.code(400).send({ error: 'invalid_request', message: 'Los datos enviados no son válidos.' });
  }
  if (err && (err.statusCode === 415 || err.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE')) {
    return reply.code(415).send({ error: 'unsupported_media_type', message: 'El formato de los datos no es válido.' });
  }
  if (err && (err.statusCode === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE')) {
    return reply.code(413).send({ error: 'too_large', message: 'El archivo es demasiado grande para ser de Pañol.' });
  }
  if (err && err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: 'invalid_request', message: 'La solicitud no es válida.' });
  }
  req.log.error(err);
  return reply.code(500).send({ error: 'internal', message: 'Ocurrió un error inesperado.' });
}
