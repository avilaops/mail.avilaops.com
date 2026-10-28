export class AuthError extends Error {
  constructor(message: string, readonly statusCode = 401) {
    super(message);
    this.name = "AuthError";
  }
}
