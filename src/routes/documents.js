const express = require('express');
const router = express.Router();
const Joi = require('joi');
const Document = require('../models/Document');

// list, newest first - supports ?status=needs_review to filter the review queue
router.get('/', async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const docs = await Document.find(filter)
    .select('originalName status validationIssues createdAt extracted.total extracted.vendorName')
    .sort({ createdAt: -1 })
    .limit(100);

  res.json(docs);
});

router.get('/:id', async (req, res) => {
  const doc = await Document.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'document not found' });
  res.json(doc);
});

const correctionSchema = Joi.object({
  field: Joi.string().required(),
  newValue: Joi.string().allow('').required()
});

// human-in-the-loop correction - a reviewer fixes a field the model got wrong.
// we log the old/new value pair so this history can later feed a few-shot
// prompt to improve accuracy on similar documents
router.patch('/:id/correct', async (req, res) => {
  const { error, value } = correctionSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.message });

  const doc = await Document.findById(req.params.id);
  if (!doc) return res.status(404).json({ error: 'document not found' });

  const { field, newValue } = value;
  const oldValue = doc.extracted[field];

  doc.corrections.push({ field, oldValue: String(oldValue ?? ''), newValue });
  doc.extracted[field] = newValue;
  doc.status = 'validated';
  doc.validationIssues = doc.validationIssues.filter(issue => !issue.toLowerCase().includes(field.toLowerCase()));

  await doc.save();
  res.json(doc);
});

module.exports = router;
