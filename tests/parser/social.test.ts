import { describe, it, expect } from "vitest";
import { parseResults } from "../../src/search/parser.js";

function page(body: string): string {
  return `<html><body>${body}</body></html>`;
}

describe("parseResults — social media (category-social)", () => {
  it("extracts all social media-specific fields", () => {
    const html = page(`
      <article class="result result-default category-social media">
        <a class="url_header" href="https://lemmy.world/c/technology"></a>
        <h3><a href="https://lemmy.world/c/technology">Technology Community</a></h3>
        <p class="content">A community about technology.</p>
        <time class="published_date" datetime="2023-01-01T00:00:00Z">January 1, 2023</time>
        <div class="highlight">inscritos: 1056 | publicações: 85 | usuários ativos: 29</div>
        <div class="engines"><span>lemmy</span></div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.category).toBe("social media");
    expect(r.url).toBe("https://lemmy.world/c/technology");
    expect(r.title).toBe("Technology Community");
    expect(r.content).toBe("A community about technology.");
    expect(r.publishedDate).toBe("2023-01-01T00:00:00Z");
    expect(r.socialMeta).toBe("inscritos: 1056 | publicações: 85 | usuários ativos: 29");
    expect(r.engines).toEqual(["lemmy"]);
  });

  it("dispatches on category-social token (SearXNG writes it as two CSS tokens: category-social + media)", () => {
    const html = page(`
      <article class="result category-social media">
        <h3><a href="https://mastodon.social/@user">@user</a></h3>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.category).toBe("social media");
  });

  it("strips HTML tags from content (Mastodon bios may contain inline markup)", () => {
    const html = page(`
      <article class="result result-default category-social media">
        <h3><a href="https://mastodon.social/@user">@user</a></h3>
        <p class="content">Bio with <a href="#">#hashtag</a> and <em>emphasis</em>.</p>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.content).not.toMatch(/<a/);
    expect(r.content).not.toMatch(/<em/);
  });

  it("returns undefined socialMeta when highlight element is absent", () => {
    const html = page(`
      <article class="result result-default category-social media">
        <h3><a href="https://mastodon.social/@user">@user</a></h3>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.socialMeta).toBeUndefined();
  });

  it("returns undefined publishedDate when time element is absent", () => {
    const html = page(`
      <article class="result result-default category-social media">
        <h3><a href="https://lemmy.world/post/1">Post</a></h3>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.publishedDate).toBeUndefined();
  });
});
