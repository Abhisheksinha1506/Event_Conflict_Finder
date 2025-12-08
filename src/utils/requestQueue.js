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
   * Optimized: Uses async/await with proper yielding to prevent blocking event loop
   */
  async processQueue(apiName) {
    if (this.processing.get(apiName)) {
      return;
    }

    this.processing.set(apiName, true);
    const queue = this.queues.get(apiName);
    const MAX_QUEUE_SIZE = 1000; // Prevent memory issues with very long queues

    // Process queue in batches with proper yielding
    const processBatch = async () => {
      let processed = 0;
      const BATCH_SIZE = 10; // Process 10 items per batch
      
      while (queue && queue.length > 0 && processed < BATCH_SIZE) {
        // Check queue size limit
        if (queue.length > MAX_QUEUE_SIZE) {
          console.warn(`RequestQueue: Queue size (${queue.length}) exceeds limit (${MAX_QUEUE_SIZE}). Clearing excess items.`);
          // Remove excess items from front of queue
          while (queue.length > MAX_QUEUE_SIZE) {
            const item = queue.shift();
            if (item && item.reject) {
              item.reject(new Error('Queue size limit exceeded'));
            }
          }
        }
        
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

        processed++;
        
        // Small delay between requests to avoid overwhelming APIs
        if (processed < BATCH_SIZE && queue.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      // Yield to event loop before processing next batch
      if (queue && queue.length > 0) {
        // Use setImmediate or setTimeout(0) to yield to event loop
        await new Promise(resolve => {
          if (typeof setImmediate !== 'undefined') {
            setImmediate(resolve);
          } else {
            setTimeout(resolve, 0);
          }
        });
        // Process next batch
        await processBatch();
      } else {
        this.processing.set(apiName, false);
      }
    };

    await processBatch();
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

