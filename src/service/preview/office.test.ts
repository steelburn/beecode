import assert from 'node:assert/strict';
import test from 'node:test';
import type { ZipEntry } from '../skills/zip';
import { columnIndex, convertOffice, decodeXml, officeFormat } from './office';

/** One archive part, as `readZip` would hand it over. */
function part(name: string, xml: string): ZipEntry {
  return { name, data: Buffer.from(xml, 'utf8') };
}

test('officeFormat recognises Word, Excel and PowerPoint by extension', () => {
  assert.equal(officeFormat('report.docx'), 'docx');
  assert.equal(officeFormat('Report.DOCM'), 'docx');
  assert.equal(officeFormat('book.xlsx'), 'xlsx');
  assert.equal(officeFormat('deck.pptx'), 'pptx');
  assert.equal(officeFormat('notes.txt'), undefined);
  assert.equal(officeFormat('no-extension'), undefined);
});

test('decodeXml handles named, decimal and hex references', () => {
  assert.equal(decodeXml('a &amp; b &lt;c&gt; &quot;d&quot;'), 'a & b <c> "d"');
  assert.equal(decodeXml('caf&#233; &#x2713;'), 'café ✓');
  assert.equal(decodeXml('&unknown;'), '&unknown;');
});

test('a Word document keeps headings, bold runs, tables and bullets', () => {
  const xml = `<?xml version="1.0"?><w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Bold </w:t></w:r><w:r><w:t>plain</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>item</w:t></w:r></w:p>
  </w:body></w:document>`;
  const result = convertOffice([part('word/document.xml', xml)], 'docx');
  assert.match(result.html, /<h3>Report<\/h3>/);
  assert.match(result.html, /<strong>Bold <\/strong>plain/);
  assert.match(result.html, /<table class="doc-table">/);
  assert.match(result.html, /<td>A<\/td><td>B<\/td>/);
  assert.match(result.html, /doc-item">• item/);
  assert.equal(result.note, undefined);
});

test('a Word archive without word/document.xml says so instead of failing', () => {
  const result = convertOffice([], 'docx');
  assert.equal(result.html, '');
  assert.match(result.note ?? '', /not a Word document/);
});

test('a workbook is shown sheet by sheet, shared strings and numbers resolved', () => {
  const entries = [
    part('xl/sharedStrings.xml', '<sst><si><t>Name</t></si><si><t>Ada</t></si></sst>'),
    part(
      'xl/workbook.xml',
      '<workbook><sheets><sheet name="People" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    part(
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    part(
      'xl/worksheets/sheet1.xml',
      `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c></row>
        <row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>42</v></c></row>
      </sheetData></worksheet>`,
    ),
  ];
  const result = convertOffice(entries, 'xlsx');
  assert.match(result.html, /<h3>People<\/h3>/);
  assert.match(result.html, /<td>Name<\/td>/);
  assert.match(result.html, /<td>Ada<\/td><td>42<\/td>/);
});

test('a cell reference maps to its column, and gaps are kept', () => {
  assert.equal(columnIndex('A1'), 0);
  assert.equal(columnIndex('B7'), 1);
  assert.equal(columnIndex('AA3'), 26);
  const entries = [
    part('xl/workbook.xml', '<workbook><sheets><sheet name="S" r:id="rId1"/></sheets></workbook>'),
    part(
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>',
    ),
    part(
      'xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row r="1"><c r="C1" t="inlineStr"><is><t>third</t></is></c></row></sheetData></worksheet>',
    ),
  ];
  const result = convertOffice(entries, 'xlsx');
  assert.match(result.html, /<td><\/td><td><\/td><td>third<\/td>/);
});

test('a deck is shown slide by slide with its title and bullets', () => {
  const slide = `<p:sld><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>Quarterly</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>revenue up</a:t></a:r></a:p><a:p><a:r><a:t>costs flat</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`;
  const result = convertOffice([part('ppt/slides/slide1.xml', slide)], 'pptx');
  assert.match(result.html, /Slide 1/);
  assert.match(result.html, /<h3>Quarterly<\/h3>/);
  assert.match(result.html, /<li>revenue up<\/li><li>costs flat<\/li>/);
});

test('a deck without slides says so', () => {
  const result = convertOffice([], 'pptx');
  assert.equal(result.html, '');
  assert.match(result.note ?? '', /No slides/);
});

test('text is escaped so a document cannot inject markup', () => {
  const xml = '<w:document><w:body><w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;</w:t></w:r></w:p></w:body></w:document>';
  const result = convertOffice([part('word/document.xml', xml)], 'docx');
  assert.match(result.html, /&lt;script&gt;/);
  assert.doesNotMatch(result.html, /<script>/);
});
