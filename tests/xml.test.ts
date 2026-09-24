import { describe, it, expect } from "vitest";
import { parseXml, extractSruNumberOfRecords, extractSruRecords } from "../src/utils/xml-parser.js";

describe("xml parser", () => {
  it("extracts sru records", () => {
    const xml = `<searchRetrieveResponse><numberOfRecords>2</numberOfRecords><records><record><recordData><doc><title>A</title></doc></recordData></record><record><recordData><doc><title>B</title></doc></recordData></record></records></searchRetrieveResponse>`;
    const parsed = parseXml(xml);
    const records = extractSruRecords(parsed);
    expect(records).toHaveLength(2);
    expect(extractSruNumberOfRecords(parsed)).toBe(2);
  });
});

/** Root element <r> of a parsed document. */
function r(xml: string): Record<string, unknown> {
  return (parseXml(xml) as Record<string, Record<string, unknown>>).r;
}

describe("parseXml: XML entities and character references", () => {
  it("decodes the five predefined entities in text", () => {
    expect(r(`<r><t>Tom &amp; Jerry &lt;b&gt; &quot;x&quot; &apos;y&apos;</t></r>`).t).toBe(`Tom & Jerry <b> "x" 'y'`);
  });

  it("decodes the five predefined entities in attributes", () => {
    const u = r(`<r><u a="x &amp; y" b="&lt;tag&gt;" c="&quot;q&quot;" d='&apos;s-Hertogenbosch'/></r>`).u;
    expect(u).toEqual({ a: "x & y", b: "<tag>", c: '"q"', d: "'s-Hertogenbosch" });
  });

  it("decodes query strings in URLs, in text and in attributes", () => {
    const parsed = r(`<r><link href="https://example.nl/zoek?a=1&amp;b=2">https://example.nl/zoek?a=1&amp;b=2&#38;c=3</link></r>`);
    expect(parsed.link).toEqual({ href: "https://example.nl/zoek?a=1&b=2", "#text": "https://example.nl/zoek?a=1&b=2&c=3" });
  });

  it("decodes decimal and hexadecimal character references", () => {
    const parsed = r(`<r a="&#39;s &#x27;"><t>caf&#233; &#x20AC;5 &#X41; &#x1F600; &#39;s-Hertogenbosch</t></r>`);
    // &#X41; (uppercase X) is not a valid XML reference and stays as-is.
    expect(parsed.t).toBe("café €5 &#X41; \u{1F600} 's-Hertogenbosch");
    expect(parsed.a).toBe("'s '");
  });

  it("decodes in a single pass: an escaped entity becomes that entity, never the character", () => {
    const parsed = r(`<r a="&amp;lt;&amp;#233;"><t>&amp;lt; &amp;amp; &amp;#233; &#38;lt; &#x26;gt;</t></r>`);
    expect(parsed.t).toBe("&lt; &amp; &#233; &lt; &gt;");
    expect(parsed.a).toBe("&lt;&#233;");
  });

  it("leaves unknown named entities and malformed references untouched", () => {
    const text = "&nbsp; &euml; &copy; &AMP; &amp &#; &#x; &#xZZ; &#12a; &unknown;";
    expect(r(`<r a="${text}"><t>${text}</t></r>`)).toEqual({ a: text, t: text });
  });

  it("leaves references to invalid code points untouched", () => {
    const invalid = "&#0; &#x0; &#xD800; &#xDFFF; &#55296; &#x110000; &#1114112; &#99999999999999999999;";
    const parsed = r(`<r a="${invalid}"><t>${invalid}</t><valid>&#1;|&#xD7FF;|&#xE000;|&#x10FFFF;</valid></r>`);
    expect(parsed.t).toBe(invalid);
    expect(parsed.a).toBe(invalid);
    expect(parsed.valid).toBe("\u0001|퟿||\u{10FFFF}");
  });

  it("keeps CDATA content literal", () => {
    const parsed = r(
      `<r>` +
        `<c><![CDATA[a &amp; b &lt;p&gt; &#233;]]></c>` +
        `<html><![CDATA[<p>Tom &amp; Jerry</p>]]></html>` +
        `<withAttr lang="nl"><![CDATA[R&amp;D]]></withAttr>` +
        `<mixed>x &amp; y <![CDATA[&amp;]]> z</mixed>` +
        `<nested><![CDATA[a & <![CDATA[ b &amp;]]></nested>` +
        `<empty><![CDATA[]]></empty>` +
        `</r>`,
    );
    expect(parsed.c).toBe("a &amp; b &lt;p&gt; &#233;");
    expect(parsed.html).toBe("<p>Tom &amp; Jerry</p>");
    expect(parsed.withAttr).toEqual({ lang: "nl", "#text": "R&amp;D" });
    // Text around the CDATA is decoded (and trimmed, as before); the CDATA part is not.
    expect(parsed.mixed).toBe("x & y&amp;z");
    expect(parsed.nested).toBe("a & <![CDATA[ b &amp;");
    expect(parsed.empty).toBe("");
  });

  it("does not let a CDATA opener outside CDATA affect other values", () => {
    const parsed = parseXml(
      `<r a="<![CDATA[&amp;]]>"><!-- <![CDATA[ & --><t>x &amp; y</t><c><![CDATA[1 &amp; 2]]></c></r>`,
    );
    expect(parsed).toEqual({ r: { a: "<![CDATA[&]]>", t: "x & y", c: "1 &amp; 2" } });
    expect(JSON.stringify(parsed)).not.toContain("\\u0000");
  });

  it("does not expand entities declared in a DOCTYPE", () => {
    const parsed = r(`<!DOCTYPE r [<!ENTITY secret "SECRET">]><r><t>&secret;</t><u a="&secret;"/></r>`);
    expect(parsed).toEqual({ t: "&secret;", u: { a: "&secret;" } });
  });

  it("stays safe and fast on a billion-laughs document", () => {
    let xml = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">`;
    for (let i = 1; i <= 9; i++) {
      const prev = i === 1 ? "lol" : `lol${i - 1}`;
      xml += `<!ENTITY lol${i} "${`&${prev};`.repeat(10)}">`;
    }
    xml += `]><lolz a="&lol9;">&lol9;</lolz>`;

    const started = performance.now();
    const parsed = parseXml(xml) as Record<string, unknown>;
    const elapsedMs = performance.now() - started;

    expect(parsed.lolz).toEqual({ a: "&lol9;", "#text": "&lol9;" });
    expect(elapsedMs).toBeLessThan(500);
  });

  it("keeps number parsing unchanged for values without references", () => {
    const parsed = r(
      `<r><n>42</n><f>3.5</f><neg>-7</neg><z>0344</z><h>0x1F</h><b>true</b><s>12 34</s>` +
        `<a code="0344">7</a><c><![CDATA[123]]></c><cz><![CDATA[0344]]></cz></r>`,
    );
    expect(parsed).toEqual({
      n: 42,
      f: 3.5,
      neg: -7,
      z: "0344",
      h: "0x1F",
      b: true,
      s: "12 34",
      a: { code: "0344", "#text": 7 },
      c: 123,
      cz: "0344",
    });
  });

  it("returns values that contained references as decoded strings, without number coercion", () => {
    expect(r(`<r><v>1&#48;</v></r>`).v).toBe("10");
  });
});
