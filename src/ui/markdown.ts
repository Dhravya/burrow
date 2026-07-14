/**
 * Burrow — src/ui/markdown.ts
 * Markdown renderer for the editor's preview mode (src/ui internal — the AI
 * panel has its own in src/ai/markdown.ts; CONTRACT.md §1 forbids importing
 * across modules, and this one grew doc-preview features the chat one never
 * needs). Same safety model: ALL text is HTML-escaped first, then a fixed set
 * of transforms runs over already-escaped text — file content can never
 * inject markup.
 *
 * Supports: h1–h6, fenced code, inline code, bold, italic, links, images
 * (emitted as <img data-md-src="…"> with NO src — the preview layer resolves
 * workspace-relative paths through the VFS and http(s) URLs directly, so this
 * renderer never mints a fetchable attribute itself), unordered/ordered
 * lists, blockquotes, horizontal rules, and paragraphs.
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
  // Images before links (same bracket syntax, leading !). The src lands in
  // data-md-src only; hydrateImages() decides what may become a real src.
  out = out.replace(
    /!\[([^\]]*)\]\(([^\s)]+)\)/g,
    (_m, alt: string, src: string) => `<img data-md-src="${src}" alt="${alt}" loading="lazy">`,
  );
  // Links: [text](http(s)://url). Operates on escaped text — an `&` in the
  // URL is already `&amp;`, which is valid inside an href attribute.
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
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    const rule = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);

    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }
    if (rule) {
      flushParagraph();
      closeList();
      html.push("<hr>");
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
 * Render a markdown document to safe HTML. Splits on fenced code blocks
 * (```); code content is escaped and never markdown-processed.
 */
export function renderMarkdownDoc(text: string): string {
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
      html.push(`<pre class="md-code"${langAttr}><code>${escapeHtml(code)}</code></pre>`);
    }
  }
  return html.join("");
}
