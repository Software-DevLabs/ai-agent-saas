import type { Requirement } from "../capability/registry.ts";

/**
 * A skill is a named body of instructions an agent can be granted and can read
 * with `use_skill`. This is the shape both halves share: the builtins below and
 * the rows an operator writes.
 */
export interface SkillDefinition {
  key: string;
  name: string;
  description: string;
  instructions: string;
  requires: Requirement[];
  /** Tool keys this skill asks for. Empty means the skill is pure instructions. */
  tools: string[];
  /** Unavailable core skills block a public surface from going live. */
  core: boolean;
}

/**
 * Code-owned skills. They ship with the build, cannot be edited by a tenant, and
 * are granted like any other skill — a tenant that grants nothing gets nothing.
 *
 * The rule for adding one: its instructions must be actionable with the tools
 * this build actually has. A builtin that says "search the knowledge base" before
 * knowledge exists would be a skill whose only honest outcome is a degradation.
 */
export const BUILTIN_SKILLS: readonly SkillDefinition[] = [
  {
    key: "triage",
    name: "Triage a support request",
    description: "Work out what the visitor actually needs before answering the words they typed.",
    instructions: `Before answering, decide three things and say them in one short line if the answer is not obvious:

1. **What outcome they want.** Not the words — the outcome. "Where is my login page" wants to reach a form that is already working, and an account that is locked needs a different answer than a forgotten password.
2. **What you know for certain.** Only what is in this conversation, the tools you were given, and what you were told about this product. Everything else is a guess, and a guess presented as fact costs the visitor more than an admission does.
3. **What the single blocking unknown is**, if there is one. One question, the one that changes the answer. Not a list of five.

Then:
- If the request contains an error message, a URL, or an account identifier, use it. Repeating the question back with the detail stripped is the most common way a support reply fails.
- If the visitor is describing two problems, answer the one that blocks the other and name the second as a follow-up.
- If the tone is frustrated, deal with the concrete thing first. An apology before the answer reads as stalling; an apology after the answer reads as courtesy.
- Never invent a page path, a price, a policy, a deadline or an integration name. Say what you do not have and what would settle it.`,
    requires: [],
    tools: [],
    core: false,
  },
  {
    key: "answer-shape",
    name: "Shape an answer for a website visitor",
    description: "Structure a reply so the first sentence is useful on its own and the steps survive being skimmed.",
    instructions: `A visitor reads on a phone, in a hurry, with the tab already half-closed.

- **First sentence is the whole answer.** If they read nothing else they should still know what to do. "Log in at the top right — the button says Sign in."
- **Then steps, numbered, only if there is more than one.** Two to four steps. Each one starts with the verb and names the thing to click or type. A step that says "configure your settings" is not a step.
- **Then the one thing that could go wrong**, if you know it. A known gotcha stated plainly beats a hedge on everything.
- **Then, at most, one question** — only when the answer genuinely depends on something they have not said.
- No headings in a reply shorter than six lines. No "I hope this helps", no "Great question!", no restating the question back at them.
- Links and page names are the answer's load-bearing parts: a named page they cannot find is worse than no name at all, so name only what you were actually given.
- If you do not know, the reply is still useful: say what you checked, what you could not determine, and who or what can settle it.`,
    requires: [],
    tools: [],
    core: false,
  },
];

export const BUILTIN_KEYS: readonly string[] = BUILTIN_SKILLS.map((skill) => skill.key);

export function getBuiltinSkill(key: string): SkillDefinition | null {
  return BUILTIN_SKILLS.find((skill) => skill.key === key) ?? null;
}
