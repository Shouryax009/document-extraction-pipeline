const express = require('express');
const router = express.Router();
const analytics = require('../services/analyticsService');
const { connection: redis } = require('../config/queue');
const Document = require('../models/Document');

// aggregations get expensive as the collection grows and the numbers don't
// change minute to minute, so cache-aside with a short TTL
const CACHE_TTL = 300; // seconds

async function cached(key, fn) {
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit);
  } catch (err) {
    console.warn('redis read failed, falling through to mongo:', err.message);
  }

  const fresh = await fn();

  try {
    await redis.setex(key, CACHE_TTL, JSON.stringify(fresh));
  } catch (err) {
    console.warn('redis write failed:', err.message);
  }
  return fresh;
}

router.get('/spend/monthly', async (req, res) => {
  const { from, to, vendor } = req.query;
  const key = `analytics:monthly:${from || '*'}:${to || '*'}:${vendor || '*'}`;
  res.json(await cached(key, () => analytics.monthlySpend({ from, to, vendor })));
});

router.get('/vendors', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);
  res.json(await cached(`analytics:vendors:${limit}`, () => analytics.vendorBreakdown({ limit })));
});

router.get('/anomalies', async (req, res) => {
  const sigma = parseFloat(req.query.sigma) || 2;
  res.json(await cached(`analytics:anomalies:${sigma}`, () => analytics.spendAnomalies({ sigma })));
});

router.get('/duplicates', async (req, res) => {
  const dayWindow = parseInt(req.query.days) || 30;
  res.json(await cached(`analytics:duplicates:${dayWindow}`, () => analytics.possibleDuplicates({ dayWindow })));
});

router.get('/quality', async (req, res) => {
  // pipeline health should reflect reality immediately, so no caching here
  res.json(await analytics.pipelineQuality());
});

router.get('/reconcile', async (req, res) => {
  res.json(await cached('analytics:reconcile', () => analytics.reconcileWithERP()));
});

// flat CSV export so the extracted data can be pulled into Excel/Power BI/Tableau
// without anyone needing to touch the API
router.get('/export.csv', async (req, res) => {
  const docs = await Document.find({ status: { $in: ['validated', 'needs_review'] } })
    .select('source extracted status')
    .lean();

  const headers = ['source', 'status', 'vendorName', 'invoiceNumber', 'invoiceDate', 'subtotal', 'tax', 'total', 'currency'];

  const escape = (val) => {
    if (val == null) return '';
    const str = String(val);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [headers.join(',')];
  for (const doc of docs) {
    const e = doc.extracted || {};
    lines.push([
      doc.source,
      doc.status,
      e.vendorName,
      e.invoiceNumber,
      e.invoiceDate ? new Date(e.invoiceDate).toISOString().slice(0, 10) : '',
      e.subtotal,
      e.tax,
      e.total,
      e.currency
    ].map(escape).join(','));
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="extracted-invoices.csv"');
  res.send(lines.join('\n'));
});

module.exports = router;
