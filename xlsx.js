/*
 * Petit générateur de fichiers Excel (.xlsx), sans bibliothèque externe,
 * pour que l'export fonctionne hors connexion.
 *
 * Un fichier .xlsx est un dossier compressé (zip) de fichiers XML.
 * Xlsx.build(feuilles) renvoie un Blob prêt à télécharger.
 *
 * Feuille : { name, cols: [largeurs], rows: [[cellule, ...]], freezeRow?, chart? }
 * Cellule : null, texte, nombre, ou { v, s } où s est un style :
 *   'header' 'euro' 'date' (v = 'AAAA-MM-JJ') 'title' 'totalLabel' 'totalEuro' 'pct' (0,5 = 50 %) 'bold' 'totalPct' 'note'
 * Graphique : { title, from: [col, ligne], to: [col, ligne], cats: { ref, values },
 *               series: [{ name, ref, values, color }], legend, numFmt }
 *   (col et ligne commencent à 0 ; ref s'obtient avec Xlsx.ref)
 */
const Xlsx = (() => {
  const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const NS_CHART = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
  const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const STYLES = { header: 1, euro: 2, date: 3, title: 4, totalEuro: 5, totalLabel: 6, pct: 7, bold: 8, totalPct: 9, note: 10 };

  // Échappe le texte pour le XML (et retire les caractères de contrôle interdits)
  const x = s => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function colName(i) {
    let s = '';
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
    return s;
  }
  // Référence absolue vers une plage d'une feuille : 'Synthèse'!$B$10:$B$15 (lignes à partir de 1)
  function ref(sheet, col, row1, row2 = row1) {
    const c = colName(col);
    return `'${sheet.replace(/'/g, "''")}'!$${c}$${row1}` + (row2 !== row1 ? `:$${c}$${row2}` : '');
  }
  // Date 'AAAA-MM-JJ' -> numéro de jour Excel
  function excelDate(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;
  }

  function cellXML(col, row, cell) {
    if (cell == null || cell === '') return '';
    const r = colName(col) + row;
    const spec = typeof cell === 'object' ? cell : { v: cell };
    const s = STYLES[spec.s] || 0;
    const sAttr = s ? ` s="${s}"` : '';
    let v = spec.v;
    if (spec.s === 'date' && typeof v === 'string') v = excelDate(v);
    if (v == null || v === '') return s ? `<c r="${r}"${sAttr}/>` : '';
    if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${r}"${sAttr}><v>${v}</v></c>` : '';
    return `<c r="${r}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${x(v)}</t></is></c>`;
  }

  function sheetXML(sheet, index, hasChart) {
    const pane = sheet.freezeRow
      ? `<pane ySplit="${sheet.freezeRow}" topLeftCell="A${sheet.freezeRow + 1}" activePane="bottomLeft" state="frozen"/>` : '';
    const cols = (sheet.cols || []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('');
    const rows = sheet.rows.map((cells, ri) => {
      const inner = (cells || []).map((c, ci) => cellXML(ci, ri + 1, c)).join('');
      const tall = (cells || []).some(c => c && c.s === 'title') ? ' ht="22" customHeight="1"' : '';
      return inner ? `<row r="${ri + 1}"${tall}>${inner}</row>` : '';
    }).join('');
    return HEAD + `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
      `<sheetViews><sheetView workbookViewId="0"${index === 0 ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>` +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      (cols ? `<cols>${cols}</cols>` : '') +
      `<sheetData>${rows}</sheetData>` +
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
      (hasChart ? '<drawing r:id="rId1"/>' : '') +
      '</worksheet>';
  }

  function chartXML(ch) {
    const strCache = vals => `<c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) =>
      `<c:pt idx="${i}"><c:v>${x(v)}</c:v></c:pt>`).join('')}</c:strCache>`;
    const numCache = vals => `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) =>
      (v == null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numCache>`;
    const series = ch.series.map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>` +
      `<c:tx><c:v>${x(s.name)}</c:v></c:tx>` +
      `<c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill></c:spPr>` +
      '<c:invertIfNegative val="0"/>' +
      `<c:cat><c:strRef><c:f>${x(ch.cats.ref)}</c:f>${strCache(ch.cats.values)}</c:strRef></c:cat>` +
      `<c:val><c:numRef><c:f>${x(s.ref)}</c:f>${numCache(s.values)}</c:numRef></c:val>` +
      '</c:ser>').join('');
    const txt = size => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}"/></a:pPr><a:endParaRPr lang="fr-FR"/></a:p></c:txPr>`;
    return HEAD + `<c:chartSpace xmlns:c="${NS_CHART}" xmlns:a="${NS_A}" xmlns:r="${NS_REL}">` +
      '<c:roundedCorners val="0"/><c:chart>' +
      `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1300" b="1"/></a:pPr><a:r><a:rPr lang="fr-FR" sz="1300" b="1"/><a:t>${x(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>` +
      '<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>' +
      `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}` +
      '<c:gapWidth val="80"/><c:overlap val="-10"/><c:axId val="50010"/><c:axId val="50020"/></c:barChart>' +
      '<c:catAx><c:axId val="50010"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>' +
      `<c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="low"/>${txt(900)}` +
      '<c:crossAx val="50020"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>' +
      '<c:valAx><c:axId val="50020"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>' +
      '<c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E2E7E5"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>' +
      `<c:numFmt formatCode="${x(ch.numFmt || '#,##0 "€"')}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>` +
      '<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>' + txt(900) +
      '<c:crossAx val="50010"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>' +
      '</c:plotArea>' +
      (ch.legend ? '<c:legend><c:legendPos val="t"/><c:overlay val="0"/></c:legend>' : '') +
      '<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>' +
      '<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>' +
      '</c:chartSpace>';
  }

  function drawingXML(ch) {
    const pt = ([c, r]) => `<xdr:col>${c}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${r}</xdr:row><xdr:rowOff>0</xdr:rowOff>`;
    return HEAD + `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="${NS_A}">` +
      `<xdr:twoCellAnchor><xdr:from>${pt(ch.from)}</xdr:from><xdr:to>${pt(ch.to)}</xdr:to>` +
      '<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Graphique 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
      '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>' +
      `<a:graphic><a:graphicData uri="${NS_CHART}"><c:chart xmlns:c="${NS_CHART}" xmlns:r="${NS_REL}" r:id="rId1"/></a:graphicData></a:graphic>` +
      '</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>';
  }

  const STYLES_XML = HEAD + `<styleSheet xmlns="${NS_MAIN}">` +
    '<numFmts count="2">' +
    '<numFmt numFmtId="164" formatCode="#,##0.00\\ &quot;€&quot;;[Red]\\-#,##0.00\\ &quot;€&quot;"/>' +
    '<numFmt numFmtId="165" formatCode="dd/mm/yyyy"/></numFmts>' +
    '<fonts count="5">' +
    '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="14"/><color rgb="FF1F6F5C"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><i/><sz val="10"/><color rgb="FF64716C"/><name val="Calibri"/><family val="2"/></font></fonts>' +
    '<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1F6F5C"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE3F1EC"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left/><right/><top style="thin"><color rgb="FF1F6F5C"/></top><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="11">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +                                                        // 0 normal
    '<xf numFmtId="0" fontId="3" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +                            // 1 en-tête
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +                               // 2 euros
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="left"/></xf>' + // 3 date
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +                                          // 4 titre
    '<xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>' + // 5 total €
    '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +          // 6 total libellé
    '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +                                 // 7 pourcentage
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +                                          // 8 gras
    '<xf numFmtId="9" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>' + // 9 total %
    '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +                                          // 10 note
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  /* ---------- Fichier zip (sans compression, accepté par Excel) ---------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zip(files) {
    const enc = new TextEncoder();
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = enc.encode(f.text);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // noms en UTF-8
      local.setUint16(8, 0, true);      // pas de compression
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, time, true);
      cd.setUint16(14, date, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, data.length, true);
      cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(new Uint8Array(cd.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: MIME });
  }

  function build(sheets) {
    const files = [];
    const overrides = [];
    let chartNo = 0;
    sheets.forEach((sh, i) => {
      const n = i + 1;
      files.push({ name: `xl/worksheets/sheet${n}.xml`, text: sheetXML(sh, i, !!sh.chart) });
      overrides.push([`/xl/worksheets/sheet${n}.xml`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml']);
      if (sh.chart) {
        chartNo++;
        files.push({ name: `xl/worksheets/_rels/sheet${n}.xml.rels`, text: HEAD +
          `<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/drawing" Target="../drawings/drawing${chartNo}.xml"/></Relationships>` });
        files.push({ name: `xl/drawings/drawing${chartNo}.xml`, text: drawingXML(sh.chart) });
        files.push({ name: `xl/drawings/_rels/drawing${chartNo}.xml.rels`, text: HEAD +
          `<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/chart" Target="../charts/chart${chartNo}.xml"/></Relationships>` });
        files.push({ name: `xl/charts/chart${chartNo}.xml`, text: chartXML(sh.chart) });
        overrides.push([`/xl/drawings/drawing${chartNo}.xml`, 'application/vnd.openxmlformats-officedocument.drawing+xml']);
        overrides.push([`/xl/charts/chart${chartNo}.xml`, 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml']);
      }
    });
    files.push({ name: 'xl/workbook.xml', text: HEAD +
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>` +
      sheets.map((sh, i) => `<sheet name="${x(sh.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>' });
    files.push({ name: 'xl/_rels/workbook.xml.rels', text: HEAD + `<Relationships xmlns="${NS_PKG_REL}">` +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>` });
    files.push({ name: 'xl/styles.xml', text: STYLES_XML });
    files.push({ name: '_rels/.rels', text: HEAD +
      `<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
    overrides.push(['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml']);
    overrides.push(['/xl/styles.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml']);
    files.unshift({ name: '[Content_Types].xml', text: HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      overrides.map(([p, t]) => `<Override PartName="${p}" ContentType="${t}"/>`).join('') + '</Types>' });
    return zip(files);
  }

  return { build, ref, MIME };
})();

if (typeof module !== 'undefined') module.exports = Xlsx; // pour les tests sur ordinateur
