import pino from "pino";

const destination = pino.destination({ dest: 2, sync: false });

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    base: undefined,
    redact: [
      "req.headers.authorization",
      "authorization",
      "headers.Authorization",
      "apiKey",
      "api_key",
    ],
  },
  destination,
);
