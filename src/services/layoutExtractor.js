// pdf-parse hands back a flat string with no column information, so a table row
// like "1  60572.00  -8750.00  43916.95" arrives as "160572.00-8750.0043916.95"
// and the model has no way to tell where one number ends and the next begins.
// pdfjs exposes the position of every text fragment, so we can rebuild the rows
// and columns ourselves before the model ever sees them.

const ROW_TOLERANCE = 3;   // fragments within this many units of y are one row
const COL_GAP = 4;         // horizontal gap that counts as a column break

async function loadPdfjs() {
  // pdfjs ships as ESM; the legacy build is the one that works under plain node
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

async function extractLayoutText(buffer) {
  const pdfjs = await loadPdfjs();

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    // we only want text, so don't waste time fetching font files
    disableFontFace: true
  }).promise;

  const pages = [];

  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(buildPageText(content.items));
    page.cleanup();
  }

  await doc.destroy();
  return pages.join('\n\n');
}

function buildPageText(items) {
  const fragments = items
    .filter(it => it.str && it.str.trim() !== '')
    .map(it => ({
      text: it.str,
      // transform is [a, b, c, d, e, f] - e and f are the x/y of the fragment
      x: it.transform[4],
      y: it.transform[5],
      width: it.width || 0
    }));

  if (fragments.length === 0) return '';

  const rows = groupIntoRows(fragments);

  return rows.map(renderRow).join('\n');
}

function groupIntoRows(fragments) {
  // pdf origin is bottom-left, so a larger y is further up the page
  const sorted = [...fragments].sort((a, b) => b.y - a.y || a.x - b.x);

  const rows = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const frag = sorted[i];
    const rowY = current[0].y;

    if (Math.abs(frag.y - rowY) <= ROW_TOLERANCE) {
      current.push(frag);
    } else {
      rows.push(current);
      current = [frag];
    }
  }
  rows.push(current);

  return rows;
}

function renderRow(fragments) {
  const sorted = [...fragments].sort((a, b) => a.x - b.x);

  let out = sorted[0].text;

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    const gap = curr.x - (prev.x + prev.width);

    // a wide gap means these were separate table cells. a narrow one usually
    // means pdfjs split a single word, so glue those back together untouched
    if (gap >= COL_GAP) {
      out += ' | ' + curr.text;
    } else {
      out += curr.text;
    }
  }

  return out.trim();
}

module.exports = { extractLayoutText };
