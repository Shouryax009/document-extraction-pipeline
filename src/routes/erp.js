const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const upload = require('../middleware/upload');
const Document = require('../models/Document');
const { parseERPExport } = require('../services/sources/erpSource');
const { validateExtraction } = require('../services/validationService');

// ERP rows are already structured, so they skip OCR and the LLM entirely and go
// straight through validation. no queue needed - this is just a bulk insert.
router.post('/import', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });

  let parsed;
  try {
    parsed = parseERPExport(req.file.path);
  } catch (err) {
    return res.status(400).json({ error: `could not parse export: ${err.message}` });
  }

  if (parsed.records.length === 0) {
    return res.status(400).json({ error: 'export contained no rows' });
  }

  const batchId = crypto.randomUUID();

  const docs = parsed.records.map((record, i) => {
    const issues = validateExtraction(record);
    // line items never come through in a summary-level ERP export, so that
    // particular complaint isn't meaningful here
    const relevant = issues.filter(issue => !issue.includes('line items'));

    return {
      originalName: `${req.file.originalname}#row${i + 2}`,
      source: 'erp',
      batchId,
      status: relevant.length > 0 ? 'needs_review' : 'validated',
      extracted: record,
      validationIssues: relevant
    };
  });

  const inserted = await Document.insertMany(docs, { ordered: false });

  res.status(201).json({
    batchId,
    imported: inserted.length,
    detectedColumns: parsed.detectedColumns,
    unmappedColumns: parsed.unmappedColumns,
    needsReview: docs.filter(d => d.status === 'needs_review').length
  });
});

module.exports = router;
