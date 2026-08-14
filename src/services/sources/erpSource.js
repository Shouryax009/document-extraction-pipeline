const fs = require('fs');
const { parse } = require('csv-parse/sync');

// Most ERPs (Tally, Zoho Books, Odoo) let you export transactions as CSV. Column
// names differ per system, so instead of hardcoding one vendor's format we map
// known header variants onto our internal field names.
const COLUMN_ALIASES = {
  vendorName: ['vendor', 'vendor name', 'supplier', 'supplier name', 'party', 'party name'],
  invoiceNumber: ['invoice no', 'invoice number', 'inv no', 'bill no', 'voucher no', 'document no'],
  invoiceDate: ['date', 'invoice date', 'bill date', 'voucher date', 'posting date'],
  subtotal: ['subtotal', 'taxable value', 'net amount', 'amount before tax'],
  tax: ['tax', 'tax amount', 'gst', 'gst amount', 'vat'],
  total: ['total', 'grand total', 'invoice total', 'amount', 'gross amount'],
  currency: ['currency', 'curr']
};

function buildHeaderMap(headers) {
  const map = {};
  const normalized = headers.map(h => h.toLowerCase().trim());

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = normalized.findIndex(h => aliases.includes(h));
    if (idx !== -1) map[field] = headers[idx];
  }
  return map;
}

// numbers in ERP exports come with currency symbols, thousands separators, and
// sometimes parentheses for negatives - strip all of it before parsing
function toNumber(raw) {
  if (raw == null || raw === '') return null;
  const cleaned = String(raw).replace(/[^0-9.\-()]/g, '');
  const negative = cleaned.includes('(') && cleaned.includes(')');
  const value = parseFloat(cleaned.replace(/[()]/g, ''));
  if (isNaN(value)) return null;
  return negative ? -value : value;
}

function toDate(raw) {
  if (!raw) return null;
  // ERP exports commonly use DD-MM-YYYY or DD/MM/YYYY which Date.parse reads wrong
  const match = String(raw).trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    const [, d, m, y] = match;
    return new Date(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
  }
  const parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function parseERPExport(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const rows = parse(content, { columns: true, skip_empty_lines: true, trim: true });

  if (rows.length === 0) return { records: [], unmappedColumns: [] };

  const headers = Object.keys(rows[0]);
  const headerMap = buildHeaderMap(headers);

  const mappedHeaders = new Set(Object.values(headerMap));
  const unmappedColumns = headers.filter(h => !mappedHeaders.has(h));

  const records = rows.map(row => ({
    vendorName: headerMap.vendorName ? row[headerMap.vendorName] : null,
    invoiceNumber: headerMap.invoiceNumber ? row[headerMap.invoiceNumber] : null,
    invoiceDate: headerMap.invoiceDate ? toDate(row[headerMap.invoiceDate]) : null,
    subtotal: headerMap.subtotal ? toNumber(row[headerMap.subtotal]) : null,
    tax: headerMap.tax ? toNumber(row[headerMap.tax]) : null,
    total: headerMap.total ? toNumber(row[headerMap.total]) : null,
    currency: headerMap.currency ? row[headerMap.currency] : 'INR',
    lineItems: []
  }));

  return { records, unmappedColumns, detectedColumns: headerMap };
}

module.exports = { parseERPExport };
