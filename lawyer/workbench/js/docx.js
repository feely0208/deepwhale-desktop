/**
 * docx.js — 生成**真正的 OOXML .docx**（不是把 HTML 改个后缀的假 .docx）
 * ---------------------------------------------------------------------------
 * 与鸿蒙端 entry/src/main/ets/common/Docx.ets 是同一套算法，两端产出一致。
 *
 * 为什么不用现成的 zip 库：桌面端 node_modules 里没有（jszip/adm-zip/archiver 都没有），
 * 而这个 ZIP 是 stored（不压缩）的写法，自己拼只有 100 多行、零依赖、条目名完全可控。
 * .docx 对内部路径要求精确（[Content_Types].xml / _rels/.rels / word/document.xml），
 * 路径错了 Word 直接打不开。
 *
 * 产出：最小可用 .docx —— 正文段落流 + A4 + 1 英寸页边距 + 1.5 倍行距。
 * 底版刻意中性（宋体/小四），用户拿到后自行排版打印。
 */
(function () {
  "use strict";

  // ── CRC32 ──────────────────────────────────────────────────────────
  var CRC_TABLE = null;
  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    var t = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    CRC_TABLE = t;
    return t;
  }
  function crc32(buf) {
    var t = crcTable(), c = -1;
    for (var i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  // ── ZIP（stored，不压缩）───────────────────────────────────────────
  function utf8(s) { return new TextEncoder().encode(s); }

  function buildZip(entries) {
    var head = [], central = [], offset = 0;
    function u16(a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF); }
    function u32(a, v) { a.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF); }

    entries.forEach(function (e) {
      var nb = utf8(e.name), start = offset;
      u32(head, 0x04034b50);
      u16(head, 20);          // version needed
      u16(head, 0x0800);      // flag: UTF-8 文件名
      u16(head, 0);           // compression: stored
      u16(head, 0);           // mod time
      u16(head, 0x21);        // mod date (1980-01-01)
      u32(head, crc32(e.data));
      u32(head, e.data.length);
      u32(head, e.data.length);
      u16(head, nb.length);
      u16(head, 0);           // extra len
      for (var i = 0; i < nb.length; i++) head.push(nb[i]);
      for (var j = 0; j < e.data.length; j++) head.push(e.data[j]);
      offset = start + 30 + nb.length + e.data.length;

      u32(central, 0x02014b50);
      u16(central, 20); u16(central, 20); u16(central, 0x0800);
      u16(central, 0); u16(central, 0); u16(central, 0x21);
      u32(central, crc32(e.data));
      u32(central, e.data.length); u32(central, e.data.length);
      u16(central, nb.length);
      u16(central, 0); u16(central, 0); u16(central, 0); u16(central, 0);
      u32(central, 0);        // external attrs
      u32(central, start);    // local header offset
      for (var m = 0; m < nb.length; m++) central.push(nb[m]);
    });

    var cdOffset = offset, tail = [];
    u32(tail, 0x06054b50);
    u16(tail, 0); u16(tail, 0);
    u16(tail, entries.length); u16(tail, entries.length);
    u32(tail, central.length);
    u32(tail, cdOffset);
    u16(tail, 0);

    var all = head.concat(central, tail);
    var out = new Uint8Array(all.length);
    for (var p = 0; p < all.length; p++) out[p] = all[p];
    return out;
  }

  // ── OOXML ──────────────────────────────────────────────────────────
  function xmlEsc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  var CONTENT_TYPES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';

  var RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';

  /** 一个段落：居中大标题 / 普通正文 */
  function para(text, isTitle) {
    var jc = isTitle ? '<w:jc w:val="center"/>' : "";
    var sz = isTitle ? "32" : "24";                 // 半磅：32=16pt，24=12pt
    var bold = isTitle ? "<w:b/>" : "";
    var line = '<w:spacing w:line="360" w:lineRule="auto"/>';   // 1.5 倍行距
    return "<w:p><w:pPr>" + jc + line + "</w:pPr>"
      + '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="SimSun"/>'
      + bold + '<w:sz w:val="' + sz + '"/><w:szCs w:val="' + sz + '"/></w:rPr>'
      + '<w:t xml:space="preserve">' + xmlEsc(text) + "</w:t></w:r></w:p>";
  }

  /**
   * 生成 .docx 字节。
   * @param {string} title 文档标题（居中、16pt）
   * @param {string[]} paragraphs 正文段落（12pt、1.5 倍行距、A4、1 英寸页边距）
   * @returns {Uint8Array}
   */
  function buildDocx(title, paragraphs) {
    var body = [];
    if (String(title || "").trim()) body.push(para(String(title).trim(), true));
    (paragraphs || []).forEach(function (p) {
      if (String(p || "").trim()) body.push(para(p, false));
    });
    // A4 纵向：11906 x 16838 twips；页边距 1440 twips = 1 英寸
    var sect = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
      + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>';
    var document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + "<w:body>" + body.join("") + sect + "</w:body></w:document>";

    return buildZip([
      { name: "[Content_Types].xml", data: utf8(CONTENT_TYPES) },
      { name: "_rels/.rels", data: utf8(RELS) },
      { name: "word/document.xml", data: utf8(document) }
    ]);
  }

  window.Docx = { build: buildDocx };
})();
