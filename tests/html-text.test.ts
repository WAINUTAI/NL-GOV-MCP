import { describe, expect, it } from "vitest";
import { htmlToText } from "../src/utils/html-text.js";

describe("htmlToText", () => {
  it("strips tags and keeps the text", () => {
    expect(htmlToText('<p>Heeft u <strong>schulden</strong>? Lees <a href="/x?a=1&b=2">meer</a>.</p>')).toBe(
      "Heeft u schulden? Lees meer.",
    );
    expect(htmlToText('<span class="x" title="a > b">tekst</span>')).toBe("tekst");
    expect(htmlToText("regel<br/>volgende<br />laatste")).toBe("regel volgende laatste");
    expect(htmlToText("<o:p></o:p>Word-HTML")).toBe("Word-HTML");
  });

  it("separates block-level elements so words do not glue together", () => {
    expect(htmlToText("<p>Meld u aan.</p><p>Voor vragen belt u ons.</p>")).toBe("Meld u aan. Voor vragen belt u ons.");
    expect(htmlToText("<ul><li>paspoort</li><li>ID-kaart</li></ul>")).toBe("paspoort ID-kaart");
    expect(htmlToText("<H2>Kosten</H2><DIV>€ 80</DIV>")).toBe("Kosten € 80");
    expect(htmlToText("<table><tr><td>a</td><td>b</td></tr></table>")).toBe("a b");
    // Inline elements do not add a space.
    expect(htmlToText("ge<em>meente</em>")).toBe("gemeente");
  });

  it("drops script and style blocks and comments, content included", () => {
    expect(htmlToText("<p>voor</p><script>alert('<p>x</p>')</script><p>na</p>")).toBe("voor na");
    expect(htmlToText('<STYLE type="text/css">p { color: red }</STYLE>tekst')).toBe("tekst");
    expect(htmlToText("a<!-- <p>verborgen</p> -->b")).toBe("a b");
    expect(htmlToText("a<script>nooit afgesloten")).toBe("a");
  });

  it("leaves plain-text comparisons alone", () => {
    expect(htmlToText("a < b")).toBe("a < b");
    expect(htmlToText("5 > 3 en 2 < 4")).toBe("5 > 3 en 2 < 4");
    expect(htmlToText("inkomen <€ 1.500")).toBe("inkomen <€ 1.500");
    expect(htmlToText("Ernst &Young & partners")).toBe("Ernst &Young & partners");
  });

  it("decodes entities only after stripping, so escaped markup stays literal", () => {
    expect(htmlToText("Typ &lt;b&gt; voor vet")).toBe("Typ <b> voor vet");
    expect(htmlToText("<p>&lt;p&gt;</p>")).toBe("<p>");
  });

  it("decodes the named entities seen in municipal product texts", () => {
    expect(htmlToText("Tarief&nbsp;2026:&nbsp;&euro;&nbsp;80&hellip;")).toBe("Tarief 2026: € 80…");
    expect(htmlToText("co&ouml;rdinatie, pati&euml;nt, caf&eacute;, &Eacute;&eacute;n, gar&ccedil;on")).toBe(
      "coördinatie, patiënt, café, Één, garçon",
    );
    expect(htmlToText("&lsquo;a&rsquo; &ldquo;b&rdquo; &bdquo;c&rdquo; &laquo;d&raquo; 1&ndash;2&mdash;3")).toBe(
      "‘a’ “b” „c” «d» 1–2—3",
    );
    expect(htmlToText("&copy; &reg; &trade; 20&deg; a&middot;b &bull; &quot;x&quot; &apos;y&apos; &amp;")).toBe(
      '© ® ™ 20° a·b • "x" \'y\' &',
    );
    expect(htmlToText("ver&shy;hui&shy;zing")).toBe("verhuizing");
  });

  it("decodes numeric references within the valid range only", () => {
    expect(htmlToText("Omgevingsprogramma&#039;s &#8364; &#x20AC; &#X20ac; &#233;")).toBe("Omgevingsprogramma's € € € é");
    expect(htmlToText("a&#160;b")).toBe("a b");
    expect(htmlToText("ver&#173;huizing")).toBe("verhuizing");
    expect(htmlToText("&#0; &#xD800; &#x110000; &#99999999;")).toBe("&#0; &#xD800; &#x110000; &#99999999;");
  });

  it("decodes in a single pass", () => {
    expect(htmlToText("&amp;nbsp;")).toBe("&nbsp;");
    expect(htmlToText("&amp;lt;p&amp;gt;")).toBe("&lt;p&gt;");
    expect(htmlToText("Kunst &amp;amp; cultuur")).toBe("Kunst &amp; cultuur");
  });

  it("keeps unknown named entities literal", () => {
    expect(htmlToText("&foo; &nbsp &NBSP; &constructor; &toString;")).toBe("&foo; &nbsp &NBSP; &constructor; &toString;");
  });

  it("collapses whitespace and trims", () => {
    expect(htmlToText("  <p>\n  Maakt u zich\tzorgen  </p>\n")).toBe("Maakt u zich zorgen");
    expect(htmlToText("")).toBe("");
  });
});
