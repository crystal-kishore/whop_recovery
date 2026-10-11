import "express";

// Augments Express's Request type with the raw request body buffer, which we
// capture via the `verify` hook on express.json() so webhook signatures can
// be validated against the exact bytes Whop sent.
declare module "express-serve-static-core" {
  interface Request {
    rawBody?: Buffer;
  }
}
