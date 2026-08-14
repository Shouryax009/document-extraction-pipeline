const mongoose = require('mongoose');

async function connectDB() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/doc-extract-ai';
  try {
    await mongoose.connect(uri);
    console.log('mongo connected ->', uri);
  } catch (err) {
    console.error('mongo connection failed:', err.message);
    process.exit(1);
  }
}

module.exports = connectDB;
