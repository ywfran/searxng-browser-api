import { describe, it, expect } from "vitest";
import { parseResults } from "../../src/search/parser.js";

function page(body: string): string {
  return `<html><body>${body}</body></html>`;
}

describe("parseResults — science (result-paper)", () => {
  it("extracts all paper-specific fields with English labels", () => {
    const html = page(`
      <article class="result result-paper category-science">
        <a class="url_header" href="https://arxiv.org/abs/1706.03762"></a>
        <h3><a href="https://arxiv.org/abs/1706.03762">Attention Is All You Need</a></h3>
        <p class="content">Abstract of the paper.</p>
        <div class="attributes">
          <div><span>Authors:</span><span>Vaswani et al.</span></div>
          <div><span>Journal:</span><span>NeurIPS 2017</span></div>
          <div><span>Date:</span><span>2017-12-06</span></div>
          <div><span>DOI:</span><span>10.48550/arXiv.1706.03762</span></div>
          <div><span>ISSN:</span><span>2692-8205</span></div>
          <div><span>Tags:</span><span>cs.LG, cs.AI</span></div>
        </div>
        <p class="altlink"><a href="https://arxiv.org/pdf/1706.03762">PDF</a></p>
        <div class="engines"><span>arxiv</span></div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.category).toBe("science");
    expect(r.url).toBe("https://arxiv.org/abs/1706.03762");
    expect(r.title).toBe("Attention Is All You Need");
    expect(r.content).toBe("Abstract of the paper.");
    expect(r.author).toBe("Vaswani et al.");
    expect(r.journal).toBe("NeurIPS 2017");
    expect(r.publishedDate).toBe("2017-12-06");
    expect(r.doi).toBe("10.48550/arXiv.1706.03762");
    expect(r.issn).toBe("2692-8205");
    expect(r.tags).toBe("cs.LG, cs.AI");
    expect(r.pdfUrl).toBe("https://arxiv.org/pdf/1706.03762");
    expect(r.engines).toEqual(["arxiv"]);
  });

  it("extracts author and journal with Portuguese locale labels", () => {
    const html = page(`
      <article class="result result-paper">
        <h3><a href="https://scholar.example.com/paper">Paper</a></h3>
        <div class="attributes">
          <div><span>Autor:</span><span>João Silva</span></div>
          <div><span>Jornal:</span><span>Revista Brasileira</span></div>
        </div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.author).toBe("João Silva");
    expect(r.journal).toBe("Revista Brasileira");
  });

  it("matches pdfUrl from altlink when link text is PDF (case-insensitive)", () => {
    const html = page(`
      <article class="result result-paper">
        <h3><a href="https://scholar.example.com/paper">Paper</a></h3>
        <p class="altlink"><a href="https://scholar.example.com/doc.pdf">Full Text</a></p>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.pdfUrl).toBe("https://scholar.example.com/doc.pdf");
  });

  it("matches pdfUrl when altlink text is exactly 'PDF'", () => {
    const html = page(`
      <article class="result result-paper">
        <h3><a href="https://scholar.example.com/paper">Paper</a></h3>
        <p class="altlink"><a href="https://scholar.example.com/fulltext">PDF</a></p>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.pdfUrl).toBe("https://scholar.example.com/fulltext");
  });

  it("returns undefined for all optional fields when absent", () => {
    const html = page(`
      <article class="result result-paper">
        <h3><a href="https://scholar.example.com/paper">Paper</a></h3>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.author).toBeUndefined();
    expect(r.journal).toBeUndefined();
    expect(r.publishedDate).toBeUndefined();
    expect(r.doi).toBeUndefined();
    expect(r.issn).toBeUndefined();
    expect(r.tags).toBeUndefined();
    expect(r.pdfUrl).toBeUndefined();
  });
});
