const express = require('express');
const router = express.Router();
const monitoring = require('../utils/monitoring');

// Get system status
router.get('/status', async (req, res) => {
  try {
    const status = await monitoring.getStatus();
    res.json(status);
  } catch (error) {
    console.error('Monitoring status error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Failed to get monitoring status'
    });
  }
});

// Health check endpoint
router.get('/health', async (req, res) => {
  try {
    const health = await monitoring.getHealthCheck();
    const statusCode = health.healthy ? 200 : 503;
    res.status(statusCode).json(health);
  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({ 
      healthy: false,
      status: 'error',
      message: error.message
    });
  }
});

module.exports = router;

