import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "./types.js";

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
  const parsed = JSON.parse(raw) as AppConfig;

  if (process.env.NL_GOV_HTTP_PORT) {
    parsed.server.httpPort = Number(process.env.NL_GOV_HTTP_PORT);
  }

  return parsed;
}

export const ENV_KEYS = {
  KNMI_API_KEY: "KNMI_API_KEY",
  OVERHEID_API_KEY: "OVERHEID_API_KEY",
  BAG_API_KEY: "BAG_API_KEY",
} as const;
