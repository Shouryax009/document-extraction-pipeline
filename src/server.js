require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const connectDB = require('./config/db');
const uploadRoute = require('./routes/upload');
const documentsRoute = require('./routes/documents');
const analyticsRoute = require('./routes/analytics');
const erpRoute = require('./routes/erp');

const app = express();

connectDB();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/upload', uploadRoute);
app.use('/api/documents', documentsRoute);
app.use('/api/analytics', analyticsRoute);
app.use('/api/erp', erpRoute);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// keep error responses uniform instead of leaking stack traces
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'something went wrong' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`server running on port ${PORT}`));
