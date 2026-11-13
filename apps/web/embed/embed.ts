/**
 * The website widget: one `<script>` tag, one shadow-root panel, no framework.
 *
 * This file is built as its own IIFE bundle (see `vite.embed.config.ts`) so a
 * visitor's page pays for a chat panel, not for a console. Everything it renders
 * is built with `createElement`/`textContent` — the reply is model output running
 * on somebody else's page, and nothing it contains may become markup.
 *
 * The turn itself is not run here. The API answers 202 with a message id and the
 * widget polls the same projection an operator's run row feeds: `PENDING`,
 * `RUNNING`, `ANSWERED` or `FAILED`. The typing indicator is that status, not a
 * timer pretending to be one.
 */

import styles from "./embed.css?inline";

interface Config {
  widget: { name: string };
  agent: { name: string };
  ready: boolean;
  error?: string;
}

interface Message {
  messageId: string;
  status: "PENDING" | "RUNNING" | "ANSWERED" | "FAILED";
  reply: string | null;
  actions: { kind: "goto"; label: string; url: string }[];
  citations: { docId: string; title: string; url?: string; chunkId: string }[];
  error: string | null;
}

const POLL_MS = 800;
const POLL_TIMEOUT_MS = 130_000;

function scriptTag(): HTMLScriptElement | null {
  const current = document.currentScript as HTMLScriptElement | null;
  if (current !== null && current.dataset.key !== undefined) return current;
  return document.querySelector<HTMLScriptElement>("script[data-key][src*='/embed/']");
}

function sessionFor(key: string): string {
  const name = `saas-embed-session:${key}`;
  try {
    const existing = sessionStorage.getItem(name);
    if (existing !== null && existing.length >= 8) return existing;
    const created = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    sessionStorage.setItem(name, created);
    return created;
  } catch {
    // Storage can be disabled; continuity then lasts for this page view only.
    return Math.random().toString(36).slice(2);
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function httpUrl(raw: string): string | null {
  return /^https?:\/\//i.test(raw) ? raw : null;
}

/** Inline marks: `code`, **bold**, [text](url). Built as nodes, never as HTML. */
function inline(parent: HTMLElement, text: string): void {
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > cursor) parent.append(text.slice(cursor, at));
    const token = match[0];
    if (token.startsWith("`")) {
      parent.append(el("code", undefined, token.slice(1, -1)));
    } else if (token.startsWith("**")) {
      parent.append(el("strong", undefined, token.slice(2, -2)));
    } else {
      const label = token.slice(1, token.indexOf("]"));
      const url = httpUrl(token.slice(token.indexOf("](") + 2, -1));
      if (url === null) parent.append(label);
      else {
        const link = el("a", undefined, label);
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer nofollow";
        parent.append(link);
      }
    }
    cursor = at + token.length;
  }
  if (cursor < text.length) parent.append(text.slice(cursor));
}

/** Paragraphs, headings, lists and fenced code — the subset models actually emit. */
function render(parent: HTMLElement, markdown: string): void {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let list: HTMLElement | null = null;
  let paragraph: HTMLElement | null = null;
  let fence: string[] | null = null;

  for (const line of lines) {
    if (fence !== null) {
      if (line.trim().startsWith("```")) {
        parent.append(el("pre", "code", fence.join("\n")));
        fence = null;
      } else fence.push(line);
      continue;
    }
    if (line.trim().startsWith("```")) {
      fence = [];
      list = null;
      paragraph = null;
      continue;
    }
    if (line.trim() === "") {
      list = null;
      paragraph = null;
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading !== null) {
      list = null;
      paragraph = null;
      const node = el((heading[1] ?? "#").length === 1 ? "h3" : "h4", "heading");
      inline(node, heading[2] ?? "");
      parent.append(node);
      continue;
    }
    const item = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item !== null) {
      if (list === null) {
        list = el("ul");
        paragraph = null;
        parent.append(list);
      }
      const li = el("li");
      inline(li, item[2] ?? "");
      list.append(li);
      continue;
    }
    if (paragraph === null) {
      paragraph = el("p");
      list = null;
      parent.append(paragraph);
    }
    if (paragraph.textContent !== "") paragraph.append(document.createElement("br"));
    inline(paragraph, line);
  }
  if (fence !== null && fence.length > 0) parent.append(el("pre", "code", fence.join("\n")));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

class Widget {
  private readonly base: string;
  private readonly key: string;
  private readonly session: string;
  private readonly log: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly send: HTMLButtonElement;
  private readonly title: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly launcher: HTMLButtonElement;
  private agentName = "Assistant";
  private ready = false;
  private waiting = false;

  constructor(base: string, key: string) {
    this.base = base;
    this.key = key;
    this.session = sessionFor(key);

    const host = el("div");
    host.setAttribute("data-saas-embed", "");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles;
    root.append(style);

    this.launcher = el("button", "launcher", "Ask us");
    this.launcher.type = "button";
    this.launcher.setAttribute("aria-label", "Open the support assistant");
    this.dot = el("span", "dot");
    this.title = el("span", "title", "Assistant");
    const close = el("button", "close", "\u00d7");
    close.type = "button";
    close.setAttribute("aria-label", "Close the assistant");
    const head = el("header", "head");
    const identity = el("div", "identity");
    identity.append(this.dot, this.title);
    head.append(identity, close);

    this.log = el("div", "log");
    this.log.setAttribute("aria-live", "polite");
    this.input = el("textarea", "input");
    this.input.rows = 1;
    this.input.placeholder = "Ask a question\u2026";
    this.input.setAttribute("aria-label", "Your message");
    this.send = el("button", "send", "Send");
    this.send.type = "button";
    const composer = el("footer", "composer");
    composer.append(this.input, this.send);
    this.panel = el("section", "panel");
    this.panel.hidden = true;
    this.panel.append(head, this.log, composer);
    root.append(this.launcher, this.panel);

    this.launcher.addEventListener("click", () => this.show(true));
    close.addEventListener("click", () => this.show(false));
    this.send.addEventListener("click", () => void this.submit());
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void this.submit();
      }
    });
    this.input.addEventListener("input", () => {
      this.input.style.height = "auto";
      this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`;
    });

    void this.start();
  }

  private show(open: boolean): void {
    this.panel.hidden = !open;
    this.launcher.hidden = open;
    if (open) this.input.focus();
  }

  private line(kind: "bot" | "visitor" | "note", text: string): HTMLElement {
    const row = el("div", `row ${kind}`);
    const bubble = el("div", "bubble");
    render(bubble, text);
    row.append(bubble);
    this.log.append(row);
    this.log.scrollTop = this.log.scrollHeight;
    return row;
  }

  private note(text: string): HTMLElement {
    const row = el("div", "row note");
    row.append(el("span", "bubble", text));
    this.log.append(row);
    this.log.scrollTop = this.log.scrollHeight;
    return row;
  }

  private typing(): HTMLElement {
    const row = el("div", "row bot typing");
    const bubble = el("div", "bubble");
    for (let i = 0; i < 3; i += 1) bubble.append(el("i"));
    row.append(bubble);
    this.log.append(row);
    this.log.scrollTop = this.log.scrollHeight;
    return row;
  }

  private setReady(ready: boolean): void {
    this.ready = ready;
    this.dot.className = ready ? "dot live" : "dot";
    this.send.disabled = !ready || this.waiting;
    this.input.disabled = !ready;
  }

  private async start(): Promise<void> {
    try {
      const response = await fetch(`${this.base}/embed/v1/config?key=${encodeURIComponent(this.key)}`, {
        credentials: "omit",
      });
      if (!response.ok) {
        this.title.textContent = "Assistant unavailable";
        this.note(response.status === 403 ? "This widget is not allowed on this site." : "This assistant is not available right now.");
        return;
      }
      const config = (await response.json()) as Config;
      this.agentName = config.agent.name;
      this.title.textContent = this.agentName;
      this.setReady(config.ready);
      if (!config.ready) this.note("This assistant is not available right now.");
    } catch {
      this.title.textContent = "Assistant unavailable";
      this.note("The assistant could not be reached. Check your connection and reload.");
    }
  }

  private async submit(): Promise<void> {
    const text = this.input.value.trim();
    if (text === "" || !this.ready || this.waiting) return;
    this.input.value = "";
    this.input.style.height = "auto";
    this.waiting = true;
    this.setReady(true);
    this.line("visitor", text);
    const typing = this.typing();
    try {
      const response = await fetch(`${this.base}/embed/v1/message`, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: this.key, sessionId: this.session, message: text }),
      });
      if (response.status === 429) {
        typing.remove();
        this.note("Too many messages just now \u2014 please wait a moment.");
        return;
      }
      if (!response.ok) {
        typing.remove();
        this.note(
          response.status === 403
            ? "This widget is not allowed on this site."
            : "The assistant could not take that message. Please try again.",
        );
        return;
      }
      const accepted = (await response.json()) as { messageId: string };
      const message = await this.poll(accepted.messageId);
      typing.remove();
      if (message === null) {
        this.note("The assistant is taking longer than expected. Please try again.");
        return;
      }
      if (message.status === "FAILED") {
        this.note(message.error ?? "The assistant could not answer that.");
        return;
      }
      if (message.reply !== null) this.answer(message);
    } catch {
      typing.remove();
      this.note("The message did not reach the assistant. Please try again.");
    } finally {
      this.waiting = false;
      this.setReady(this.ready);
    }
  }

  private async poll(messageId: string): Promise<Message | null> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const url = `${this.base}/embed/v1/message/${encodeURIComponent(messageId)}?key=${encodeURIComponent(
        this.key,
      )}&session=${encodeURIComponent(this.session)}`;
      const response = await fetch(url, { credentials: "omit" });
      if (response.status === 404) return null;
      if (!response.ok) continue;
      const message = (await response.json()) as Message;
      if (message.status === "ANSWERED" || message.status === "FAILED") return message;
    }
    return null;
  }

  private answer(message: Message): void {
    const row = this.line("bot", message.reply ?? "");
    if (message.actions.length > 0) {
      const actions = el("div", "actions");
      for (const action of message.actions) {
        const url = httpUrl(action.url);
        if (url === null) continue;
        const button = el("button", "action", action.label);
        button.type = "button";
        button.addEventListener("click", () => window.open(url, "_blank", "noopener"));
        actions.append(button);
      }
      row.querySelector(".bubble")?.append(actions);
    }
    if (message.citations.length > 0) {
      const sources = el("div", "sources");
      sources.append(el("span", "sources-label", "Sources: "));
      for (const citation of message.citations.slice(0, 4)) {
        const url = citation.url === undefined ? null : httpUrl(citation.url);
        if (url === null) {
          sources.append(el("span", "source", citation.title));
        } else {
          const link = el("a", "source", citation.title);
          link.href = url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          sources.append(link);
        }
      }
      row.querySelector(".bubble")?.append(sources);
    }
    this.log.scrollTop = this.log.scrollHeight;
  }
}

function boot(): void {
  const script = scriptTag();
  if (script === null) return;
  const key = script.dataset.key ?? "";
  if (key === "") {
    console.warn("[saas-embed] this script tag has no data-key — the widget cannot identify its assistant");
    return;
  }
  const override = script.dataset.api;
  let base: string;
  try {
    base = (override !== undefined ? new URL(override) : new URL(script.src)).origin;
  } catch {
    console.warn("[saas-embed] the script src is not a usable URL");
    return;
  }
  new Widget(base, key);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
