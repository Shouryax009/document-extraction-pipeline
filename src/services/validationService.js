// Flags what looks wrong so a human can check it. Doesn't fix anything.
function validateExtraction(extracted) {
  const issues = [];

  if (!extracted.vendorName) issues.push('vendor name missing');
  if (extracted.total == null) issues.push('total amount missing');

  if (extracted.invoiceDate && isNaN(Date.parse(extracted.invoiceDate))) {
    issues.push('invoice date could not be parsed');
  }

  const items = Array.isArray(extracted.lineItems) ? extracted.lineItems : [];

  // plenty of real invoices (utility bills, receipts) have no itemised table,
  // so a missing one isn't an error - only check the maths if items exist.
  // the amount column on a line row is that row's final total, so it
  // reconciles against the invoice total, not the pre-tax subtotal
  if (items.length > 0 && extracted.total != null) {
    const sum = items.reduce((acc, it) => {
      const amt = typeof it.amount === 'number' ? it.amount : (it.quantity || 0) * (it.unitPrice || 0);
      return acc + amt;
    }, 0);

    if (Math.abs(sum - extracted.total) > Math.max(1, extracted.total * 0.02)) {
      issues.push(`line items sum (${sum.toFixed(2)}) doesn't match total (${extracted.total})`);
    }
  }

  // subtotal here is the taxable value, which on a GST invoice is already net
  // of any discount - subtracting the discount again would double-count it
  if (extracted.subtotal != null && extracted.total != null) {
    const computed = extracted.subtotal
      + (extracted.tax || 0)
      + (extracted.shipping || 0);

    if (Math.abs(computed - extracted.total) > Math.max(1, extracted.total * 0.01)) {
      issues.push(`subtotal + tax (${computed.toFixed(2)}) doesn't add up to stated total (${extracted.total})`);
    }
  }

  return issues;
}

module.exports = { validateExtraction };
