const Document = require('../models/Document');

const CLEAN_STATUSES = ['validated', 'needs_review'];

// spend per month, so the dashboard can draw a trend line. we bucket on
// invoiceDate rather than createdAt - when the invoice was actually issued
// matters, not when someone got around to uploading it
async function monthlySpend({ from, to, vendor } = {}) {
  const match = {
    status: { $in: CLEAN_STATUSES },
    'extracted.invoiceDate': { $ne: null },
    'extracted.total': { $ne: null }
  };
  if (from || to) {
    match['extracted.invoiceDate'] = {};
    if (from) match['extracted.invoiceDate'].$gte = new Date(from);
    if (to) match['extracted.invoiceDate'].$lte = new Date(to);
  }
  if (vendor) match['extracted.vendorName'] = vendor;

  return Document.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m', date: '$extracted.invoiceDate' } },
        totalSpend: { $sum: '$extracted.total' },
        invoiceCount: { $sum: 1 },
        avgInvoiceValue: { $avg: '$extracted.total' }
      }
    },
    { $sort: { _id: 1 } },
    {
      $project: {
        _id: 0,
        month: '$_id',
        totalSpend: { $round: ['$totalSpend', 2] },
        invoiceCount: 1,
        avgInvoiceValue: { $round: ['$avgInvoiceValue', 2] }
      }
    }
  ]);
}

// top vendors by spend, with share of total - the classic "where is the money
// going" cut that any finance team asks for first
async function vendorBreakdown({ limit = 10 } = {}) {
  const rows = await Document.aggregate([
    {
      $match: {
        status: { $in: CLEAN_STATUSES },
        'extracted.vendorName': { $nin: [null, ''] },
        'extracted.total': { $ne: null }
      }
    },
    {
      $group: {
        _id: '$extracted.vendorName',
        totalSpend: { $sum: '$extracted.total' },
        invoiceCount: { $sum: 1 },
        avgInvoiceValue: { $avg: '$extracted.total' },
        lastInvoiceDate: { $max: '$extracted.invoiceDate' }
      }
    },
    { $sort: { totalSpend: -1 } },
    { $limit: limit }
  ]);

  const grandTotal = rows.reduce((sum, r) => sum + r.totalSpend, 0);

  return rows.map(r => ({
    vendor: r._id,
    totalSpend: Number(r.totalSpend.toFixed(2)),
    invoiceCount: r.invoiceCount,
    avgInvoiceValue: Number(r.avgInvoiceValue.toFixed(2)),
    lastInvoiceDate: r.lastInvoiceDate,
    shareOfSpend: grandTotal ? Number(((r.totalSpend / grandTotal) * 100).toFixed(1)) : 0
  }));
}

// flag invoices that sit far outside a vendor's normal range. using mean +
// 2*stddev per vendor rather than one global threshold, since a vendor who
// always bills 50k shouldn't trip the same alarm as one who always bills 500
async function spendAnomalies({ sigma = 2 } = {}) {
  const stats = await Document.aggregate([
    {
      $match: {
        status: { $in: CLEAN_STATUSES },
        'extracted.vendorName': { $nin: [null, ''] },
        'extracted.total': { $ne: null }
      }
    },
    {
      $group: {
        _id: '$extracted.vendorName',
        mean: { $avg: '$extracted.total' },
        stdDev: { $stdDevPop: '$extracted.total' },
        count: { $sum: 1 },
        invoices: {
          $push: {
            id: '$_id',
            invoiceNumber: '$extracted.invoiceNumber',
            total: '$extracted.total',
            date: '$extracted.invoiceDate'
          }
        }
      }
    },
    // a vendor with 2 invoices has no meaningful distribution yet
    { $match: { count: { $gte: 4 } } }
  ]);

  const anomalies = [];
  for (const vendor of stats) {
    if (!vendor.stdDev) continue; // every invoice identical, nothing to flag
    const threshold = vendor.mean + sigma * vendor.stdDev;

    for (const inv of vendor.invoices) {
      if (inv.total > threshold) {
        anomalies.push({
          vendor: vendor._id,
          invoiceNumber: inv.invoiceNumber,
          date: inv.date,
          amount: Number(inv.total.toFixed(2)),
          vendorMean: Number(vendor.mean.toFixed(2)),
          deviations: Number(((inv.total - vendor.mean) / vendor.stdDev).toFixed(2))
        });
      }
    }
  }

  return anomalies.sort((a, b) => b.deviations - a.deviations);
}

// duplicate payment detection - same vendor, same amount, close together in
// time. this is a real problem in AP teams and a genuinely useful metric
async function possibleDuplicates({ dayWindow = 30 } = {}) {
  const groups = await Document.aggregate([
    {
      $match: {
        status: { $in: CLEAN_STATUSES },
        'extracted.vendorName': { $nin: [null, ''] },
        'extracted.total': { $ne: null }
      }
    },
    {
      $group: {
        _id: { vendor: '$extracted.vendorName', total: '$extracted.total' },
        count: { $sum: 1 },
        docs: {
          $push: {
            id: '$_id',
            invoiceNumber: '$extracted.invoiceNumber',
            date: '$extracted.invoiceDate',
            source: '$source'
          }
        }
      }
    },
    { $match: { count: { $gte: 2 } } }
  ]);

  const windowMs = dayWindow * 24 * 60 * 60 * 1000;
  const flagged = [];

  for (const group of groups) {
    const dated = group.docs.filter(d => d.date).sort((a, b) => a.date - b.date);
    for (let i = 1; i < dated.length; i++) {
      if (dated[i].date - dated[i - 1].date <= windowMs) {
        flagged.push({
          vendor: group._id.vendor,
          amount: group._id.total,
          first: dated[i - 1],
          second: dated[i],
          daysApart: Math.round((dated[i].date - dated[i - 1].date) / (24 * 60 * 60 * 1000))
        });
      }
    }
  }

  return flagged;
}

// extraction quality metrics - how well is the pipeline itself doing. this is
// the metric an ops team would actually watch day to day
async function pipelineQuality() {
  const byStatus = await Document.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);

  const counts = Object.fromEntries(byStatus.map(r => [r._id, r.count]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const processed = (counts.validated || 0) + (counts.needs_review || 0);

  // which validation rules fire most often - tells you where the prompt or the
  // OCR step needs work, rather than guessing
  const issueFrequency = await Document.aggregate([
    { $unwind: '$validationIssues' },
    { $group: { _id: '$validationIssues', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 10 }
  ]);

  const correctionStats = await Document.aggregate([
    { $unwind: '$corrections' },
    { $group: { _id: '$corrections.field', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);

  return {
    totalDocuments: total,
    byStatus: counts,
    straightThroughRate: processed ? Number((((counts.validated || 0) / processed) * 100).toFixed(1)) : 0,
    failureRate: total ? Number((((counts.failed || 0) / total) * 100).toFixed(1)) : 0,
    topValidationIssues: issueFrequency.map(r => ({ issue: r._id, count: r.count })),
    mostCorrectedFields: correctionStats.map(r => ({ field: r._id, count: r.count }))
  };
}

// reconciliation - invoices we extracted from documents that the ERP export
// doesn't know about, and vice versa. this is the payoff of having both sources
// in one collection
async function reconcileWithERP() {
  const all = await Document.aggregate([
    {
      $match: {
        status: { $in: CLEAN_STATUSES },
        'extracted.invoiceNumber': { $nin: [null, ''] }
      }
    },
    {
      $group: {
        _id: '$extracted.invoiceNumber',
        sources: { $addToSet: '$source' },
        vendor: { $first: '$extracted.vendorName' },
        totals: { $addToSet: '$extracted.total' }
      }
    }
  ]);

  const missingFromERP = [];
  const missingFromDocuments = [];
  const amountMismatches = [];

  for (const row of all) {
    const hasUpload = row.sources.includes('upload');
    const hasERP = row.sources.includes('erp');

    if (hasUpload && !hasERP) {
      missingFromERP.push({ invoiceNumber: row._id, vendor: row.vendor });
    } else if (hasERP && !hasUpload) {
      missingFromDocuments.push({ invoiceNumber: row._id, vendor: row.vendor });
    } else if (hasUpload && hasERP && row.totals.length > 1) {
      // same invoice number, two different amounts - one side is wrong
      amountMismatches.push({ invoiceNumber: row._id, vendor: row.vendor, amounts: row.totals });
    }
  }

  return {
    matched: all.length - missingFromERP.length - missingFromDocuments.length,
    missingFromERP,
    missingFromDocuments,
    amountMismatches
  };
}

module.exports = {
  monthlySpend,
  vendorBreakdown,
  spendAnomalies,
  possibleDuplicates,
  pipelineQuality,
  reconcileWithERP
};
