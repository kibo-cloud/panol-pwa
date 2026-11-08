// Error de regla de negocio: el mensaje se muestra tal cual al usuario.
export class DomainError extends Error {
  constructor(message, code = 'rule_violation', status = 422) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

export function tooLong(value, max, what) {
  if (String(value ?? '').length > max) throw new DomainError(`${what} admite hasta ${max} caracteres.`, 'too_long', 400);
}
