import { describe, expect, test } from "bun:test";
import { renderMarkdownDoc } from "./markdown.ts";

describe("renderMarkdownDoc", () => {
  test("renders headings, lists, code, links", () => {
    const html = renderMarkdownDoc(
      "# Title\n\n- one\n- two\n\n`code` and [a link](https://example.com)\n\n```ts\nconst x = 1;\n```",
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain("const x = 1;");
  });

  test("images emit data-md-src, never a live src attribute", () => {
    const html = renderMarkdownDoc("![logo](./burrow.svg)\n\n![ext](https://x.dev/a.png)");
    expect(html).toContain('data-md-src="./burrow.svg"');
    expect(html).toContain('alt="logo"');
    expect(html).not.toContain(" src="); // hydration decides what may load
  });

  test("h5/h6 and horizontal rules", () => {
    const html = renderMarkdownDoc("##### five\n\n---\n\n###### six");
    expect(html).toContain("<h5>five</h5>");
    expect(html).toContain("<hr>");
    expect(html).toContain("<h6>six</h6>");
  });

  test("file content cannot inject markup", () => {
    const html = renderMarkdownDoc('<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))');
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain('href="javascript:');
  });

  test("unterminated fence renders as code, not prose", () => {
    const html = renderMarkdownDoc("start\n\n```sh\nrm -rf /");
    expect(html).toContain("rm -rf /");
    expect(html).toContain("md-code");
  });
});
