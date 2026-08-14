# Doc Extract AI

Automated document data extraction pipeline. Upload an invoice (PDF or scanned image),
get back clean structured JSON, no manual data entry.

## Why this exists

Most "AI extraction demo" projects are a single API call wrapped in a Flask route.
This one is built like an actual backend service:

- **Async processing** - uploads don't block on the LLM call. A file is saved,
  a job is queued, and a worker processes it in the background.
- **OCR fallback logic** - tries direct PDF text extraction first (fast, cheap),
  only falls back to Tesseract OCR if the PDF is a scanned image with no text layer.
- **Validation layer** - after extraction, line items are cross-checked against the
  subtotal, and subtotal + tax is checked against total. Anything that doesn't add
  up gets flagged for review instead of silently trusting the model.
- **Human-in-the-loop correction** - a reviewer can fix a field from the dashboard.
  Corrections are logged (old value -> new value) so they can later be used as
  few-shot examples to improve extraction accuracy.
- **Retry + backoff** - failed jobs retry automatically (3 attempts, exponential
  backoff) via BullMQ before landing in `failed` status.

## Architecture

```
Client (upload) --> POST /api/upload --> Document saved (status: queued)
                                       --> job pushed to Redis queue
                                              |
                                              v
                                    Worker process (separate from API server)
                                       |
                                       v
                          OCR/parse -> LLM extraction -> validation
                                       |
                                       v
                          Document updated (status: validated | needs_review | failed)

Client polls GET /api/documents  -->  review dashboard shows status + flagged issues
Client PATCH /api/documents/:id/correct  -->  human fixes a field
```

The API server and the worker are separate processes on purpose - this is the
same pattern real systems use so a slow LLM call never blocks incoming uploads.

## ERP ingestion

Live ERP APIs (SAP, Oracle, Tally) need enterprise credentials, so ingestion is
built around the way ERP data actually moves in practice: scheduled CSV exports.

`POST /api/erp/import` takes an export, auto-detects columns (it maps ~30 known
header variants — `Party Name`, `Supplier`, `Vendor` all resolve to the same
field), normalizes messy values (`"12,500.00"`, `(450)` for negatives,
`DD-MM-YYYY` dates), and writes rows into the same collection as extracted
documents, tagged `source: 'erp'`.

Because both sources land in one collection, `/api/analytics/reconcile` can
compare them: invoices found in documents but missing from the ERP, invoices in
the ERP with no supporting document, and same-invoice-number-different-amount
mismatches. `sample-erp-export.csv` is included to test the flow.

## Analytics

| Endpoint | What it answers |
|----------|-----------------|
| `/api/analytics/spend/monthly` | Spend trend bucketed by invoice month |
| `/api/analytics/vendors` | Top vendors by spend, with share of total |
| `/api/analytics/anomalies` | Invoices >2σ above that vendor's own average |
| `/api/analytics/duplicates` | Same vendor + amount within a 30-day window |
| `/api/analytics/quality` | Straight-through rate, failure rate, most-corrected fields |
| `/api/analytics/reconcile` | Document vs ERP gaps |
| `/api/analytics/export.csv` | Flat export for Excel / Power BI / Tableau |

Aggregations are cache-aside in Redis (5 min TTL) since they get expensive as the
collection grows and don't change minute to minute. Anomaly detection uses a
per-vendor mean + 2σ threshold rather than one global cutoff — a vendor who always
bills ₹50k shouldn't trip the same alarm as one who always bills ₹500.

Dashboard at `/analytics.html`.

## Stack

Node.js, Express, MongoDB (Mongoose aggregation pipelines), Redis + BullMQ (job
queue + analytics cache), Groq API (LLM extraction, Llama 3.3 70B), pdf-parse +
Tesseract.js (OCR), csv-parse (ERP ingestion), Chart.js (dashboard), Joi.

## Setup

Requires Node 18+, a running MongoDB instance, a running Redis instance, and a
free Groq API key (https://console.groq.com).

```bash
npm install
cp .env.example .env
# fill in GROQ_API_KEY, and MONGO_URI/REDIS_URL if not running on localhost defaults

# terminal 1
npm start          # API server on :5000

# terminal 2
npm run worker     # background extraction worker
```

Load the sample ERP data to see the analytics dashboard populated:

```bash
curl -F "file=@sample-erp-export.csv" http://localhost:5000/api/erp/import
```

Then open `http://localhost:5000` and drop in an invoice.

## API

| Method | Route                          | What it does                              |
|--------|--------------------------------|--------------------------------------------|
| POST   | /api/upload                    | Upload a file (`file` form field), queues extraction |
| GET    | /api/documents                 | List documents, optional `?status=needs_review` |
| GET    | /api/documents/:id             | Full record including raw OCR text          |
| PATCH  | /api/documents/:id/correct     | Submit a human correction for one field     |
| POST   | /api/erp/import                | Bulk-import an ERP CSV export               |
| GET    | /api/analytics/*               | See the analytics table above               |

## Known limitations / next steps

- Extraction schema is invoice-shaped right now; generalizing to other doc types
  (resumes, receipts) means making the prompt + validation rules configurable per
  document type rather than hardcoded.
- No auth yet - fine for a portfolio demo, would need per-user document scoping
  for anything real.
- Corrections are logged but not yet fed back into the prompt as few-shot examples -
  that's the natural next step to actually improve accuracy over time.
- No rate limiting on the upload endpoint yet - would add Redis-backed limiting
  (reusing the same Redis instance) before this ever saw untrusted traffic.

## Note on this build

This was scaffolded end-to-end but not run against a live Mongo/Redis/Groq stack
in this environment - go through the setup steps above locally before treating any
part of it as tested. If something breaks, the most likely spots are pdf-parse's
handling of unusual PDF encodings and the Groq JSON mode edge cases (empty response,
truncated JSON on very long documents) - both worth stress-testing with 5-10 real
invoices before calling this "done" on your resume.
