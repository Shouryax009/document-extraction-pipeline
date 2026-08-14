const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const EXTRACTION_PROMPT = `You extract structured invoice data from raw OCR text. The text may have broken
line spacing or OCR noise - do your best to infer the correct values anyway.

Return ONLY valid JSON, no markdown fences, no commentary, matching exactly this shape:

{
  "documentType": "invoice" or "receipt" or "other",
  "vendorName": string or null,
  "invoiceNumber": string or null,
  "invoiceDate": "YYYY-MM-DD" or null,
  "dueDate": "YYYY-MM-DD" or null,
  "subtotal": number or null,   // the taxable value / net amount BEFORE tax, not the gross or pre-discount amount
  "discount": number or null,   // always positive, even if the invoice prints it as a negative
  "tax": number or null,
  "discount": number or null,
  "shipping": number or null,
  "total": number or null,
  "currency": string (3-letter code, guess "INR" if unclear from an Indian invoice),
  "lineItems": [
    { "description": string, "quantity": number, "unitPrice": number, "amount": number }
  ]
}

If a field genuinely isn't present in the text, use null rather than guessing a value. Numbers should
be plain numbers, not strings, and should not include currency symbols or commas.The text comes from a PDF with table structure preserved: cells within a row are separated
by " | ". Use the column positions to work out which number is which — the first cell in a
product row is usually quantity, not part of the amount.
Set documentType to "other" if this is not an invoice or receipt (for example a letter,
resume, or contract), and leave every other field null in that case.`;

async function extractFields(rawText) {
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    temperature: 0, // we want consistent extraction, not creative writing
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      { role: 'user', content: rawText.slice(0, 12000) } // keep well under context limit
    ],
    response_format: { type: 'json_object' }
  });

  const content = completion.choices[0].message.content;

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`model did not return valid JSON: ${err.message}`);
  }

  return parsed;
}

module.exports = { extractFields };
