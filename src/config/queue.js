const { Queue, QueueEvents } = require('bullmq');
const IORedis = require('ioredis');

// bullmq wants maxRetriesPerRequest null on the connection, otherwise it throws
const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null
});

const extractionQueue = new Queue('extraction', { connection });

const queueEvents = new QueueEvents('extraction', { connection });

module.exports = { extractionQueue, queueEvents, connection };
