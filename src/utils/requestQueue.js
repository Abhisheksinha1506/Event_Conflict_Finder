/**
 * Request Queue System
 * Queues API requests when rate limits are approaching
 */
class RequestQueue {
  constructor() {
    this.queues = new Map(); // Map of API name to queue
    this.processing = new Map(); // Track if queue is being processed
  }

  /**
   * Add request to queue
   */
  async enqueue(apiName, requestFn, priority = 0) {
    if (!this.queues.has(apiName)) {
      this.queues.set(apiName, []);
      this.processing.set(apiName, false);
    }

    return new Promise((resolve, reject) => {
      const queueItem = {
        requestFn,
        resolve,
        reject,
        priority,
        timestamp: Date.now()
      };

      const queue = this.queues.get(apiName);
      
      // Insert based on priority (higher priority first)
      if (priority > 0) {
        const insertIndex = queue.findIndex(item => item.priority < priority);
        if (insertIndex === -1) {
          queue.push(queueItem);
        } else {
          queue.splice(insertIndex, 0, queueItem);
        }
      } else {
        queue.push(queueItem);
      }

      // Start processing if not already processing
      if (!this.processing.get(apiName)) {
        this.processQueue(apiName);
      }
    });
  }

  /**
   * Process queue for an API
   */
  async processQueue(apiName) {
    if (this.processing.get(apiName)) {
      return;
    }

    this.processing.set(apiName, true);
    const queue = this.queues.get(apiName);

    while (queue && queue.length > 0) {
      const item = queue.shift();
      
      if (!item || !item.requestFn) {
        continue;
      }
      
      try {
        const result = await item.requestFn();
        if (item.resolve) {
          item.resolve(result);
        }
      } catch (error) {
        if (item.reject) {
          item.reject(error);
        } else {
          console.error(`RequestQueue: Unhandled error for ${apiName}:`, error.message);
        }
      }

      // Small delay between requests to avoid overwhelming APIs
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    this.processing.set(apiName, false);
  }

  /**
   * Get queue length for an API
   */
  getQueueLength(apiName) {
    const queue = this.queues.get(apiName);
    return queue ? queue.length : 0;
  }

  /**
   * Clear queue for an API
   */
  clearQueue(apiName) {
    const queue = this.queues.get(apiName);
    if (queue) {
      queue.forEach(item => {
        item.reject(new Error('Queue cleared'));
      });
      queue.length = 0;
    }
  }

  /**
   * Get queue statistics
   */
  getStats() {
    const stats = {};
    this.queues.forEach((queue, apiName) => {
      stats[apiName] = {
        length: queue.length,
        processing: this.processing.get(apiName) || false
      };
    });
    return stats;
  }
}

// Export singleton instance
module.exports = new RequestQueue();

