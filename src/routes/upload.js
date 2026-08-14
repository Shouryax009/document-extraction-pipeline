const express = require('express');
const router = express.Router();
const upload = require('../middleware/upload');
const Document = require('../models/Document');
const { extractionQueue } = require('../config/queue');

router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'no file uploaded, field name should be "file"' });
  }

  const doc = await Document.create({
    originalName: req.file.originalname,
    filePath: req.file.path,
    mimeType: req.file.mimetype,
    status: 'queued'
  });

  await extractionQueue.add('extract', { documentId: doc._id.toString() }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 }
  });

  res.status(202).json({
    message: 'file queued for extraction',
    documentId: doc._id
  });
});

module.exports = router;
