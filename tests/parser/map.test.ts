import { describe, it, expect } from "vitest";
import { parseResults } from "../../src/search/parser.js";

function page(body: string): string {
  return `<html><body>${body}</body></html>`;
}

describe("parseResults — map (result-map)", () => {
  it("extracts all map-specific fields", () => {
    const boundingBox = [-23.56, -23.54, -46.64, -46.62];
    const html = page(`
      <article class="result result-map">
        <a class="url_header" href="https://www.openstreetmap.org/node/12345678"></a>
        <h3><a href="https://www.openstreetmap.org/node/12345678">Parque Ibirapuera</a></h3>
        <a class="searxng_init_map"
           data-map-lat="-23.5874"
           data-map-lon="-46.6576"
           data-map-boundingbox="${JSON.stringify(boundingBox)}">
        </a>
        <table>
          <tr><th>Website</th><td><a href="https://parqueibirapuera.org">Link</a></td></tr>
          <tr><th>Wikipedia</th><td><a href="https://en.wikipedia.org/wiki/Ibirapuera">Link</a></td></tr>
        </table>
        <div class="engines"><span>openstreetmap</span></div>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.category).toBe("map");
    expect(r.url).toBe("https://www.openstreetmap.org/node/12345678");
    expect(r.title).toBe("Parque Ibirapuera");
    expect(r.latitude).toBeCloseTo(-23.5874);
    expect(r.longitude).toBeCloseTo(-46.6576);
    expect(r.boundingBox).toEqual(boundingBox);
    expect(r.mapLinks).toEqual({
      Website: "https://parqueibirapuera.org",
      Wikipedia: "https://en.wikipedia.org/wiki/Ibirapuera",
    });
    expect(r.engines).toEqual(["openstreetmap"]);
  });

  it("uses table cell text as fallback when td contains no link", () => {
    const html = page(`
      <article class="result result-map">
        <h3><a href="https://www.openstreetmap.org/node/1">Place</a></h3>
        <a class="searxng_init_map" data-map-lat="48.8566" data-map-lon="2.3522"></a>
        <table>
          <tr><th>Population</th><td>2 161 000</td></tr>
        </table>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.mapLinks?.["Population"]).toBe("2 161 000");
  });

  it("returns undefined latitude and longitude when data attributes are absent", () => {
    const html = page(`
      <article class="result result-map">
        <h3><a href="https://www.openstreetmap.org/node/1">Place</a></h3>
        <a class="searxng_init_map"></a>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.latitude).toBeUndefined();
    expect(r.longitude).toBeUndefined();
  });

  it("returns undefined boundingBox for malformed JSON", () => {
    const html = page(`
      <article class="result result-map">
        <h3><a href="https://www.openstreetmap.org/node/1">Place</a></h3>
        <a class="searxng_init_map" data-map-boundingbox="{not valid json}"></a>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.boundingBox).toBeUndefined();
  });

  it("returns undefined boundingBox when parsed array length is not exactly 4", () => {
    const html = page(`
      <article class="result result-map">
        <h3><a href="https://www.openstreetmap.org/node/1">Place</a></h3>
        <a class="searxng_init_map" data-map-boundingbox="[1, 2, 3]"></a>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.boundingBox).toBeUndefined();
  });

  it("returns undefined mapLinks when table has no rows", () => {
    const html = page(`
      <article class="result result-map">
        <h3><a href="https://www.openstreetmap.org/node/1">Place</a></h3>
        <a class="searxng_init_map" data-map-lat="0" data-map-lon="0"></a>
      </article>
    `);
    const [r] = parseResults(html);
    expect(r.mapLinks).toBeUndefined();
  });

  it("skips articles with no valid url", () => {
    const html = page(`
      <article class="result result-map">
        <h3><a href="#fragment">Place</a></h3>
      </article>
    `);
    expect(parseResults(html)).toHaveLength(0);
  });
});
