require('dotenv').config();
const { Worker } = require('bullmq');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { connection } = require('../config/queue');
const Document = require('../models/Document');
const { extractText } = require('../services/ocrService');
const { extractFields } = require('../services/extractionService');
const { validateExtraction } = require('../services/validationService');

connectDB();

// concurrency of 3 - LLM calls are the bottleneck here (network bound), so a
// few can run in parallel without hammering the machine's CPU
const worker = new Worker('extraction', async (job) => {
  const { documentId } = job.data;
  const doc = await Document.findById(documentId);
  if (!doc) throw new Error(`document ${documentId} not found`);

  doc.status = 'processing';
  await doc.save();

  try {
    const rawText = await extractText(doc.filePath, doc.mimeType);
    doc.rawText = rawText;

    const extracted = await extractFields(rawText);
// bail early on things that aren't invoices at all - no point running
    // validation rules against a cover letter
    if (extracted.documentType === 'other') {
      doc.status = 'failed';
      doc.processingError = 'not an invoice or receipt';
      await doc.save();
      return { status: doc.status, issues: [] };
    }
    doc.extracted = extracted;

    const issues = validateExtraction(extracted);
    doc.validationIssues = issues;
    doc.status = issues.length > 0 ? 'needs_review' : 'validated';

    await doc.save();
    return { status: doc.status, issues };
  } catch (err) {
    doc.status = 'failed';
    doc.processingError = err.message;
    await doc.save();
    throw err; // let bullmq record the failure + retry per its backoff policy
  }
}, {
  connection,
  concurrency: 3
});

worker.on('completed', (job, result) => {
  console.log(`job ${job.id} done -> ${result.status}`);
});

worker.on('failed', (job, err) => {
  console.error(`job ${job.id} failed:`, err.message);
});

console.log('extraction worker started, waiting for jobs...');

process.on('SIGTERM', async () => {
  await worker.close();
  await mongoose.disconnect();
  process.exit(0);
});
