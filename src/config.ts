import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./types.js";

const appConfigSchema = z.object({
  server: z.object({
    name: z.string(),
    version: z.string(),
    httpPort: z.number().int().min(1).max(65535),
  }),
  temporal: z.object({
    defaultTimeZone: z.string(),
  }),
  cacheTtlMs: z.object({
    default: z.number(),
    cbsCatalog: z.number(),
    tkEntityLists: z.number(),
    knmiObservations: z.number(),
    knmiHistorical: z.number(),
    dataOverheidDatasetList: z.number(),
    rijksoverheidLists: z.number(),
  }),
  limits: z.object({
    defaultRows: z.number().int().min(1),
    maxRows: z.number().int().min(1),
  }),
  endpoints: z.object({
    dataOverheid: z.string().url(),
    cbsV4: z.string().url(),
    cbsV3: z.string().url(),
    tweedeKamer: z.string().url(),
    bekendmakingenSru: z.string().url(),
    rijksoverheid: z.string().url(),
    knmi: z.string().url(),
    rijksbegroting: z.string().url(),
    duoDatasets: z.string().url(),
    duoRio: z.string().url(),
    apiRegister: z.string().url(),
  }),
}) satisfies z.ZodType<AppConfig>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveConfigPath(): string {
  const candidates = [
    // ts-node/tsx from src/
    path.resolve(__dirname, "../config/default.json"),
    // compiled JS from dist/src/
    path.resolve(__dirname, "../../config/default.json"),
    // process working dir fallback
    path.resolve(process.cwd(), "config/default.json"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `default.json not found. Looked in: ${candidates.join(", ")}`,
  );
}

export function loadConfig(): AppConfig {
  const configPath = resolveConfigPath();
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = appConfigSchema.parse(JSON.parse(raw));

  if (process.env.NL_GOV_HTTP_PORT) {
    const port = Number(process.env.NL_GOV_HTTP_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid NL_GOV_HTTP_PORT: ${process.env.NL_GOV_HTTP_PORT}`);
    }
    parsed.server.httpPort = port;
  }

  if (process.env.NL_GOV_TIMEZONE) {
    parsed.temporal.defaultTimeZone = process.env.NL_GOV_TIMEZONE;
  }

  return parsed;
}

export const ENV_KEYS = {
  KNMI_API_KEY: "KNMI_API_KEY",
  OVERHEID_API_KEY: "OVERHEID_API_KEY",
  BAG_API_KEY: "BAG_API_KEY",
} as const;
