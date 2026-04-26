import winston from "winston";

const level = process.env.LOG_LEVEL ?? "info";

export const logger = winston.createLogger({
  level,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [new winston.transports.Console({ format: winston.format.simple() })],
});
