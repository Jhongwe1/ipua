// lib/sanitize.js 的 XSS 語料測試 — 這是文章內容進頁面前的最後一道閘門。
import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "../../lib/sanitize.js";

describe("sanitizeHtml：危險內容全擋", () => {
  it("<script> 連內容整段丟棄", () => {
    expect(sanitizeHtml('<p>a</p><script>alert(1)</script><p>b</p>'))
      .toBe("<p>a</p><p>b</p>");
    expect(sanitizeHtml('<script src="https://evil.com/x.js"></script>')).toBe("");
    expect(sanitizeHtml('<SCRIPT>alert(1)</SCRIPT>')).toBe("");             // 大小寫混淆
    expect(sanitizeHtml('<script>alert(1)')).toBe("");                      // 沒關的 script：尾巴全丟
  });
  it("style／iframe／svg／object 等危險容器整段丟棄", () => {
    expect(sanitizeHtml('<style>*{display:none}</style>x')).toBe("x");
    expect(sanitizeHtml('<iframe src="https://evil.com">fallback</iframe>x')).toBe("x");
    expect(sanitizeHtml('<svg><script>alert(1)</script></svg>x')).toBe("x");
    expect(sanitizeHtml('<object data="x"></object><embed src="x">y')).toBe("y");
    expect(sanitizeHtml('<form action="/steal"><button>送出</button></form>y')).toBe("y");
  });
  it("on* 事件屬性剝除（img onerror 經典款）", () => {
    expect(sanitizeHtml('<img src="/img/1" onerror="alert(1)">'))
      .toBe('<img src="/img/1">');
    expect(sanitizeHtml('<a href="/x" onclick="alert(1)" onmouseover=alert(2)>k</a>'))
      .toBe('<a href="/x">k</a>');
  });
  it("style 屬性剝除", () => {
    expect(sanitizeHtml('<p style="position:fixed">x</p>')).toBe("<p>x</p>");
  });
  it("javascript:／vbscript:／data:text/html 的 href 整個屬性拔掉", () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="JaVaScRiPt:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="vbscript:msgbox(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>')).toBe("<a>x</a>");
  });
  it("scheme 的空白／控制字元／實體混淆擋得住", () => {
    expect(sanitizeHtml('<a href="java\tscript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="java\nscript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href=" javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="&#106;avascript:alert(1)">x</a>')).toBe("<a>x</a>");        // &#106;=j
    expect(sanitizeHtml('<a href="&#x6a;avascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="jav&#x0A;ascript:alert(1)">x</a>')).toBe("<a>x</a>");
  });
  it("img src 只收 http(s)/相對路徑/data:image 點陣格式", () => {
    expect(sanitizeHtml('<img src="data:image/png;base64,AAAA">'))
      .toBe('<img src="data:image/png;base64,AAAA">');
    expect(sanitizeHtml('<img src="data:image/svg+xml,<svg onload=alert(1)>">')).toBe("<img>");
    expect(sanitizeHtml('<img src="data:text/html,x">')).toBe("<img>");
  });
  it("HTML 註解移除（含條件註解）", () => {
    expect(sanitizeHtml("a<!-- <script>alert(1)</script> -->b")).toBe("ab");
    expect(sanitizeHtml("a<!--[if IE]><script>x</script><![endif]-->b")).toBe("ab");
    expect(sanitizeHtml("a<!-- 沒關的註解")).toBe("a");
  });
  it("白名單外的標籤拔掉、文字保留", () => {
    expect(sanitizeHtml('<div class="x"><span>文字</span></div>')).toBe("文字");
    expect(sanitizeHtml("<blink>閃</blink><marquee>跑</marquee>")).toBe("閃跑");
    expect(sanitizeHtml("<body onload=alert(1)><p>x</p></body>")).toBe("<p>x</p>");
  });
  it("沒配成標籤的 < 跳脫輸出", () => {
    expect(sanitizeHtml("a < b")).toBe("a &lt; b");
    expect(sanitizeHtml("<p>1 <3 2</p>")).toBe("<p>1 &lt;3 2</p>");
  });
  it("input 只收 gfm 任務清單的 checkbox", () => {
    expect(sanitizeHtml('<input checked disabled type="checkbox">'))
      .toBe('<input checked disabled type="checkbox">');
    expect(sanitizeHtml('<input type="text" value="x">')).toBe("");
    expect(sanitizeHtml('<input type="image" src="x" onerror="alert(1)">')).toBe("");
  });
});

describe("sanitizeHtml：正常內容原樣通過", () => {
  it("marked 產出的標準結構不變形", () => {
    const md =
      '<h2>標題</h2>\n<p>段落 <strong>粗</strong> <em>斜</em> <del>刪</del> ' +
      '<a href="https://example.com/a?b=1&amp;c=2">連結</a> <code>行內碼</code></p>\n' +
      '<pre><code class="language-js">const a = 1;</code></pre>\n' +
      '<ul>\n<li>一</li>\n<li>二</li>\n</ul>\n' +
      '<blockquote>\n<p>引言</p>\n</blockquote>\n<hr>';
    expect(sanitizeHtml(md)).toBe(md);
  });
  it("表格（gfm）與 align 屬性保留；非法 align 值剝除", () => {
    expect(sanitizeHtml('<table><thead><tr><th align="center">A</th></tr></thead>' +
      "<tbody><tr><td>1</td></tr></tbody></table>"))
      .toBe('<table><thead><tr><th align="center">A</th></tr></thead>' +
        "<tbody><tr><td>1</td></tr></tbody></table>");
    expect(sanitizeHtml('<td align="evil">x</td>')).toBe("<td>x</td>");
  });
  it("圖片：src/alt/width/height/loading 保留", () => {
    expect(sanitizeHtml('<img src="/img/9" alt="說明" width="600" loading="lazy">'))
      .toBe('<img src="/img/9" alt="說明" width="600" loading="lazy">');
  });
  it("相對路徑、#錨點、mailto 的連結保留", () => {
    expect(sanitizeHtml('<a href="/news/1">a</a>')).toBe('<a href="/news/1">a</a>');
    expect(sanitizeHtml('<a href="#sec">b</a>')).toBe('<a href="#sec">b</a>');
    expect(sanitizeHtml('<a href="mailto:hi@example.com">c</a>')).toBe('<a href="mailto:hi@example.com">c</a>');
  });
  it("跳脫過的文字（&lt;script&gt;）不受影響", () => {
    expect(sanitizeHtml("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"))
      .toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  });
  it("空值與非字串輸入", () => {
    expect(sanitizeHtml(null)).toBe("");
    expect(sanitizeHtml(undefined)).toBe("");
    expect(sanitizeHtml("")).toBe("");
  });
});
