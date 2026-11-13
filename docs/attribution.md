# Attribution

This project adapts interaction patterns from third-party open-source projects. No source files were copied; the implementations here are written for this codebase's stack (React 18, Tailwind CSS 3, no Base UI).

## Mastra Playground UI

- Project: `@mastra/playground-ui` (Mastra, `packages/playground-ui`)
- Licence: Apache License 2.0 (the `ee/` directory, which is separately licensed, was not used)
- What was studied and re-implemented here:
  - The collapsible, drag-resizable sidebar with a provider that persists width/collapse
    (`Sidebar` and its root provider), including the collapsed icon rail and injected link component.
  - The command palette interaction model (`⌘K` trigger, grouped results, action rows).
  - The workflow graph card anatomy (header label + type badge, body, footer status), the
    invisible top-target/bottom-source handle placement, bezier edges that change style with
    run status, and the zoom slider panel.

- Where it landed in this repository: `apps/web/src/components/layout/sidebar-provider.tsx`,
  `apps/web/src/components/layout/sidebar.tsx`, `apps/web/src/components/ui/command-palette.tsx`,
  and (from the canvas phase) `apps/web/src/components/workflow/*`.

The console's canvas remains editable and its own validation/runtime rules are unchanged; only
presentational and interaction patterns were adopted.

## Mastra Studio design system

- Project: Mastra Studio (`D:\workstation\project\dashboard` reference build)
- What was studied and re-implemented here: the achromatic oklch token ramps (background-1/2/3 and
  gray 1–10), the translucent fill/border rungs, the raised-surface rim and elevation stacks, the
  30px control/40px header rhythm, the inset app frame, and the sidebar anatomy (brand initials,
  search trigger with `Kbd`, Create menu, eyebrow groups). Components such as `Kbd`, `Avatar`,
  `StatusDot`, `CodeBlock` and the restyled primitives follow those tokens.
- Where it landed in this repository: `apps/web/src/styles.css`, `apps/web/tailwind.config.js`,
  `apps/web/src/components/ui/*`, `apps/web/src/components/layout/*`.
- Font: Mona Sans (variable, OFL 1.1) is served from `apps/web/src/assets/fonts/`. The reference's
  Commit Mono is **not** bundled; monospace text uses JetBrains Mono (OFL 1.1) served via Google
  Fonts, as before.

## Mastra skills: validation limits and progressive disclosure

- Projects: `@mastra/core` — `src/workspace/skills/schemas.ts` and
  `src/processors/processors/skills.ts` (Mastra, Apache License 2.0; no `ee/` file was read or used)
- What was studied and re-implemented here:
  - The size limits, which Mastra takes from the Agent Skills specification
    (`SKILL_LIMITS`, `schemas.ts:18-29`): name ≤ 64 characters, description ≤ 1024,
    instructions past 500 lines stop being an instruction and become a document.
    `packages/core/src/skills/validate.ts` adopts those three numbers and the same
    no-Zod plain-function style, and adds the slug rule set (no leading/trailing hyphen,
    no `--`, no reuse of a built-in key) reported as one message per broken rule.
  - Progressive disclosure (`formatSkillsCatalog`, `skills.ts:100-156`): the system prompt
    carries a catalogue of key + name + description, sorted by name so an identical grant
    set assembles byte-identically, and the body is fetched only when the model asks. Our
    `## Skills available` block and `use_skill(key)` follow that shape.
- What is deliberately ours and not a port: the error/warning split (structure the model
  relies on is enforced, taste is only reported), the `requires` → UNAVAILABLE degradation,
  and `core` blocking a public surface — none of those exist upstream.
- Where it landed: `packages/core/src/skills/validate.ts`, `packages/core/src/skills/catalog.ts`,
  `packages/core/src/capability/assemble.ts`.

## Agent activity

- The `AgentTurnObserver` lifecycle in `packages/core/src/agent-run.ts` and the activity feed UI are
  original to this repository; no third-party code was copied. The visual language for the live
  activity indicators borrows the reference dashboard's status-dot and row rhythm described above.

## Mastra web-fetch SSRF guard (intent)

- Project: `@mastra/core` — `src/tools/builtin/web-fetch.ts:17-158` (Mastra, Apache License 2.0;
  no `ee/` file was read or used)
- What was studied and re-implemented here: the guard's *intent* — resolve a hostname first, judge
  the resolved addresses (so `localhost` is only one spelling of `127.0.0.1`), and re-check after
  resolution so a DNS answer that changes between check and connect (rebinding) cannot win. Our
  `packages/core/src/site/fetch.ts` implements it against `node:http`/`node:https` with a `lookup`
  that answers from the vetted address list, a 2 MiB body cap and same-host-only redirects.
- What is deliberately ours and not a port: robots.txt parsing and HTML→text extraction —
  `web-fetch` has neither, and a crawler owes a site owner both. The chunking of a crawl into a
  page table (`packages/core/src/site/crawl.ts`) and `find_page`'s verified-URL output are this
  build's own design.
- Where it landed: `packages/core/src/site/fetch.ts`, `robots.ts`, `html.ts`, `crawl.ts`, `tools.ts`.

