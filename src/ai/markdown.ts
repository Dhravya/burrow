/**
 * Burrow — src/ai/markdown.ts
 * A tiny, dependency-free, XSS-safe markdown renderer for streamed model
 * output. Everything is HTML-escaped first; only a fixed set of inline/block
 * transforms then run over already-escaped text, so no model token can ever
 * inject markup. Supports: fenced code, inline code, bold, italic, headings,
 * unordered/ordered lists, blockquotes, links, and paragraph breaks.
 */

const escapeHtml = (raw: string): string =>
  raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// Control-char sentinel for stashed inline-code spans — cannot occur in the
// escaped prose around it, so restoring never collides with real text.
const SENTINEL = String.fromCharCode(0);
const RESTORE_RE = new RegExp(SENTINEL + "(\\d+)" + SENTINEL, "g");

/** Inline transforms applied to an already-escaped line of text. */
function inline(escaped: string): string {
  let out = escaped;
  const codeSpans: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_m, code: string) => {
    codeSpans.push(code);
    return SENTINEL + (codeSpans.length - 1) + SENTINEL;
  });
  // Links: [text](http(s)://url). Operates on escaped text — an `&` in the URL
  // is already `&amp;`, which is valid inside an href attribute.
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, text: string, href: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`,
  );
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![_\w])/g, "$1<em>$2</em>");
  // Restore inline code (contents were already HTML-escaped with the line).
  out = out.replace(RESTORE_RE, (_m, i: string) => `<code>${codeSpans[Number(i)] ?? ""}</code>`);
  return out;
}

/** Render a block of markdown (no fenced code) into HTML. */
function renderProse(block: string): string {
  const lines = block.split("\n");
  const html: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.map((l) => inline(escapeHtml(l))).join("<br>")}</p>`);
    paragraph = [];
  };
  const closeList = (): void => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);

    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1]!.length;
      html.push(`<h${level}>${inline(escapeHtml(heading[2]!))}</h${level}>`);
      continue;
    }
    if (bullet) {
      flushParagraph();
      if (listType !== "ul") {
        closeList();
        listType = "ul";
        html.push("<ul>");
      }
      html.push(`<li>${inline(escapeHtml(bullet[1]!))}</li>`);
      continue;
    }
    if (ordered) {
      flushParagraph();
      if (listType !== "ol") {
        closeList();
        listType = "ol";
        html.push("<ol>");
      }
      html.push(`<li>${inline(escapeHtml(ordered[1]!))}</li>`);
      continue;
    }
    if (quote) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${inline(escapeHtml(quote[1]!))}</blockquote>`);
      continue;
    }
    closeList();
    paragraph.push(line);
  }
  flushParagraph();
  closeList();
  return html.join("");
}

/**
 * Render streamed markdown to safe HTML. Splits on fenced code blocks (```),
 * treating an unterminated final fence as still-open code (looks right while
 * streaming). Code content is escaped and never markdown-processed.
 */
export function renderMarkdown(text: string): string {
  const parts = text.split("```");
  const html: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i % 2 === 0) {
      html.push(renderProse(part));
    } else {
      const newline = part.indexOf("\n");
      let lang = "";
      let code = part;
      if (newline !== -1) {
        const firstLine = part.slice(0, newline).trim();
        if (/^[a-zA-Z0-9_+-]*$/.test(firstLine)) {
          lang = firstLine;
          code = part.slice(newline + 1);
        }
      }
      code = code.replace(/\n$/, "");
      const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
      html.push(
        `<pre class="ai-code"${langAttr}><button class="ai-copy" title="copy" type="button">copy</button><code>${escapeHtml(code)}</code></pre>`,
      );
    }
  }
  return html.join("");
}

export { escapeHtml };
