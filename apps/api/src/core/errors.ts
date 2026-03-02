export class DomainError extends Error {
  public statusCode: number;
  public code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function assertDomain(condition: boolean, code: string, message: string, statusCode = 400): void {
  if (!condition) {
    throw new DomainError(code, message, statusCode);
  }
}
