import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { z } from 'zod'

export const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY' as const

const unavailableMessage = 'OpenRouter API key is unavailable'
const envFileUnavailableMessage = 'OpenRouter credential file is missing or unreadable'
const envFileInvalidMessage = 'OpenRouter credential file does not contain a valid key'

const openRouterKeySchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/\s/u.test(value))

function parseOpenRouterKey(value: unknown): string {
  const parsed = openRouterKeySchema.safeParse(value)
  if (!parsed.success) throw new Error(unavailableMessage)
  return parsed.data
}

/** Reads the OpenRouter key from an explicit process environment snapshot (default: current process). */
export function readOpenRouterKeyFromProcessEnv(env: NodeJS.ProcessEnv = process.env): string {
  return parseOpenRouterKey(env[OPENROUTER_API_KEY_ENV])
}

/** Reads the OpenRouter key from an explicit env file path; does not fall back to process env. */
export async function readOpenRouterKeyFromEnvFile(envFilePath: string): Promise<string> {
  let text: string
  try {
    text = await readFile(envFilePath, 'utf8')
  } catch {
    throw new Error(envFileUnavailableMessage)
  }
  let parsedEnv: NodeJS.ProcessEnv
  try {
    parsedEnv = parseEnv(text)
  } catch {
    throw new Error(envFileInvalidMessage)
  }
  try {
    return parseOpenRouterKey(parsedEnv[OPENROUTER_API_KEY_ENV])
  } catch {
    throw new Error(envFileInvalidMessage)
  }
}
