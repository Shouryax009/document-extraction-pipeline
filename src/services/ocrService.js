const fs = require('fs');
const { createWorker } = require('tesseract.js');
const { extractLayoutText } = require('./layoutExtractor');

// Text-based PDFs (anything exported from billing software) keep their layout,
// so we rebuild the table structure from coordinates. Only fall back to OCR if
// the PDF turns out to be a scan with no text layer at all.
async function extractFromPDF(filePath) {
  const buffer = fs.readFileSync(filePath);
  const text = await extractLayoutText(buffer);

  if (text && text.trim().length > 30) {
    return text;
  }

  console.log('pdf has no text layer, falling back to OCR');
  return runTesseract(filePath);
}

async function runTesseract(filePath) {
  const worker = await createWorker('eng');
  try {
    const { data } = await worker.recognize(filePath);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

async function extractText(filePath, mimeType) {
  if (mimeType === 'application/pdf') {
    return extractFromPDF(filePath);
  }
  return runTesseract(filePath);
}

module.exports = { extractText };
