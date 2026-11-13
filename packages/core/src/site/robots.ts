/**
 * robots.txt, read the way a crawler owes it to a site owner.
 *
 * Only the directives that exist in practice are honoured: `User-agent`, `Allow`
 * and `Disallow`, with `*` wildcards and a `$` end anchor. The longest matching
 * rule wins and an equally long `Allow` beats a `Disallow`, which is the rule both
 * of the widely-used implementations agree on. Anything this parser does not know
 * is ignored — which means "allow", the same direction a missing file is.
 *
 * An unreadable robots.txt (a network fault) is `null` and means allowed. A
 * robots.txt that *answers* and forbids is obeyed, and the pages it blocks are
 * reported as skipped rather than silently missing.
 */

export const CRAWLER_NAME = "saas-site-crawler";

interface Rule {
  allow: boolean;
  pattern: string;
}

interface Group {
  agents: string[];
  rules: Rule[];
}

function parse(robots: string): Group[] {
  const groups: Group[] = [];
  let agents: string[] = [];
  let rules: Rule[] = [];
  let inRules = false;
  const flush = () => {
    if (agents.length > 0) groups.push({ agents, rules });
    agents = [];
    rules = [];
    inRules = false;
  };

  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === "user-agent") {
      if (inRules) flush();
      agents.push(value.toLowerCase());
    } else if (key === "allow" || key === "disallow") {
      inRules = true;
      // `Disallow:` with an empty value is the standard way to say "nothing is
      // disallowed"; storing it as a rule would block every path.
      if (value !== "" || key === "allow") rules.push({ allow: key === "allow", pattern: value });
    }
  }
  flush();
  return groups;
}

function patternMatchLength(pattern: string, path: string): number | null {
  if (pattern === "") return null;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  const match = new RegExp(`^${source}${anchored ? "$" : ""}`).exec(path);
  // Specificity is the length of the *path* a rule matched, not the length of the
  // pattern text: "/*.pdf$" (9 characters) matches a 25-character URL and must beat
  // "Allow: /secret/public" (14 characters) when both apply to it.
  return match === null ? null : match[0].length;
}

export function robotsAllows(robots: string | null, path: string): boolean {
  if (robots === null) return true;
  const wanted = path === "" ? "/" : path;
  const groups = parse(robots);
  const mine = groups.filter((group) => group.agents.some((agent) => agent !== "*" && (CRAWLER_NAME.includes(agent) || agent.includes(CRAWLER_NAME))));
  const applicable = mine.length > 0 ? mine : groups.filter((group) => group.agents.includes("*"));
  const rules = applicable.flatMap((group) => group.rules);
  if (rules.length === 0) return true;

  let best: Rule | null = null;
  let bestLength = -1;
  for (const rule of rules) {
    const length = patternMatchLength(rule.pattern, wanted);
    if (length === null) continue;
    if (length > bestLength || (length === bestLength && rule.allow)) {
      best = rule;
      bestLength = length;
    }
  }
  return best === null || best.allow;
}
