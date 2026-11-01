export class AppError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function httpError(status: number, code: string, message: string): AppError {
  return new AppError(status, code, message);
}
