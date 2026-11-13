import { getBuiltinSkill, type SkillDefinition } from "./catalog.ts";
import { isToolKey, REQUIREMENTS, toolKeys, type Requirement } from "../capability/registry.ts";

/**
 * Skill validation, ported in rules (not in code) from Mastra's skill schemas:
 * a key is a slug the model types, so it is bounded and character-restricted;
 * the description is the one line that always sits in the prompt, so it is capped
 * hard; the body is loaded on demand, so its size is a *warning* rather than an
 * error — a long body costs tokens only when it is actually read.
 *
 * The split between errors and warnings is the whole design: structure the model
 * has to rely on is enforced, taste is reported.
 */

export const SKILL_KEY_MAX = 64;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
/** Past this many lines the body is a document, not an instruction. */
export const SKILL_INSTRUCTIONS_WARN_LINES = 500;

export interface SkillValidation {
  errors: string[];
  warnings: string[];
}

export interface SkillDraft {
  key: string;
  name: string;
  description: string;
  instructions: string;
  requires: string[];
  tools: string[];
  core: boolean;
}

/**
 * A key is `[a-z0-9-]`, no leading or trailing hyphen, no `--`. Checked as rules
 * rather than one regex so each failure can name the thing that broke — the
 * operator sees "must not contain --", not "invalid".
 */
export function validateSkillKey(key: string): string[] {
  const errors: string[] = [];
  if (key === "") return ["key is required"];
  if (key.length > SKILL_KEY_MAX) errors.push(`key must be ${SKILL_KEY_MAX} characters or fewer (this is ${key.length})`);
  if (!/^[a-z0-9-]+$/.test(key)) errors.push("key may contain only lowercase letters, digits and hyphens");
  if (key.startsWith("-")) errors.push("key must not start with a hyphen");
  if (key.endsWith("-")) errors.push("key must not end with a hyphen");
  if (key.includes("--")) errors.push("key must not contain a double hyphen");
  if (getBuiltinSkill(key) !== null) errors.push(`key "${key}" belongs to a built-in skill and cannot be reused`);
  return errors;
}

export function validateSkill(draft: SkillDraft): SkillValidation {
  const errors = validateSkillKey(draft.key);
  const warnings: string[] = [];

  if (draft.name.trim() === "") errors.push("name is required");
  else if (draft.name.length > SKILL_NAME_MAX) errors.push(`name must be ${SKILL_NAME_MAX} characters or fewer`);

  if (draft.description.trim() === "") errors.push("description is required — it is the line the model sees in the catalogue");
  else if (draft.description.length > SKILL_DESCRIPTION_MAX)
    errors.push(`description must be ${SKILL_DESCRIPTION_MAX} characters or fewer (this is ${draft.description.length})`);
  else if (draft.description.length > 200)
    warnings.push("a description over 200 characters is billed into every turn's prompt, not just the turn that reads it");

  if (draft.instructions.trim() === "") errors.push("instructions are required");
  else {
    const lines = draft.instructions.split(/\r?\n/).length;
    if (lines > SKILL_INSTRUCTIONS_WARN_LINES)
      warnings.push(`${lines} lines: the body is loaded into context whenever the model opens this skill, so it is a document rather than an instruction`);
  }

  for (const requirement of draft.requires) {
    if (!(REQUIREMENTS as readonly string[]).includes(requirement))
      errors.push(`unknown requirement "${requirement}" — this build can probe: ${REQUIREMENTS.join(", ")}`);
  }
  for (const tool of draft.tools) {
    if (!isToolKey(tool)) errors.push(`unknown tool "${tool}" — this build's registry has: ${toolKeys().join(", ") || "none"}`);
  }
  if (draft.core && draft.requires.length === 0 && draft.tools.length === 0)
    warnings.push("a core skill with no requirements can never be unavailable, which makes `core` a label rather than a gate");

  return { errors, warnings };
}

/** A tenant row becomes the same shape a builtin has, so nothing downstream branches on origin. */
export function toSkillDefinition(row: {
  key: string;
  name: string;
  description: string;
  instructions: string;
  requires: unknown;
  tools: unknown;
  core: boolean;
}): SkillDefinition {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    requires: toStringArray(row.requires) as Requirement[],
    tools: toStringArray(row.tools),
    core: row.core,
  };
}

/** Json columns are `unknown` by contract; anything that is not a string array reads as empty. */
export function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function asSkillDraft(input: {
  key?: string;
  name?: string;
  description?: string;
  instructions?: string;
  requires?: unknown;
  tools?: unknown;
  core?: boolean;
}): SkillDraft {
  return {
    // Trimmed but *not* lower-cased: the key is what the model types into
    // `use_skill`, so storing something other than what the operator wrote would
    // silently rewrite the contract. An uppercase key is a validation error.
    key: (input.key ?? "").trim(),
    name: (input.name ?? "").trim(),
    description: (input.description ?? "").trim(),
    instructions: input.instructions ?? "",
    requires: toStringArray(input.requires),
    tools: toStringArray(input.tools),
    core: input.core ?? false,
  };
}
