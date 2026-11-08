// Error de regla de negocio: el mensaje se muestra tal cual al usuario.
export class DomainError extends Error {
  constructor(message, code = 'rule_violation', status = 422) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

// Edición concurrente: la versión enviada no es la actual. `current` es el registro vigente.
export class ConflictError extends DomainError {
  constructor(current, message = 'Otra persona modificó este registro. Recargá para ver los cambios.') {
    super(message, 'conflict', 409);
    this.extra = { current };
  }
}

export const notFoundError = (message = 'No se encontró el registro.') => new DomainError(message, 'not_found', 404);

export function tooLong(value, max, what) {
  if (String(value ?? '').length > max) throw new DomainError(`${what} admite hasta ${max} caracteres.`, 'too_long', 400);
}
