const mongoose = require('mongoose');

const lineItemSchema = new mongoose.Schema({
  description: String,
  quantity: Number,
  unitPrice: Number,
  amount: Number
}, { _id: false });

const documentSchema = new mongoose.Schema({
  originalName: { type: String, required: true },
  filePath: { type: String }, // ERP-imported rows have no file of their own
  mimeType: String,

  // where this record came from - lets analytics compare what the ERP already
  // knows against what we pulled out of loose documents
  source: {
    type: String,
    enum: ['upload', 'erp'],
    default: 'upload'
  },
  batchId: String, // groups rows that came in from the same ERP export

  status: {
    type: String,
    enum: ['queued', 'processing', 'needs_review', 'validated', 'failed'],
    default: 'queued'
  },

  rawText: String, // whatever OCR/parser pulled out, kept for debugging + re-extraction

  extracted: {
    documentType: String,
    vendorName: String,
    invoiceNumber: String,
    invoiceDate: Date,
    dueDate: String,
    subtotal: Number,
    tax: Number,
    discount: Number,
    shipping: Number,
    total: Number,
    currency: String,
    lineItems: [lineItemSchema]
  },

  // validation layer writes here so a reviewer can see exactly what tripped
  validationIssues: [String],

  // if a human corrects a field after review, we log it — useful later for
  // building a few-shot correction set to improve the prompt
  corrections: [{
    field: String,
    oldValue: String,
    newValue: String,
    correctedAt: { type: Date, default: Date.now }
  }],

  processingError: String
}, { timestamps: true });

// analytics groups by vendor and buckets by month, so these two carry most of
// the aggregation load once the collection gets big
documentSchema.index({ 'extracted.vendorName': 1 });
documentSchema.index({ 'extracted.invoiceDate': -1 });
documentSchema.index({ status: 1, source: 1 });

module.exports = mongoose.model('Document', documentSchema);
