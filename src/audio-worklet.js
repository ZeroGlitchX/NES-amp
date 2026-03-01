/**
 * NSF Audio Worklet Processor
 * Thin buffer consumer — receives Float32Array sample buffers via postMessage,
 * queues them, and outputs 128 samples per process() call.
 */

class NSFWorkletProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.bufferQueue = [];
        this.currentBuffer = null;
        this.currentOffset = 0;

        this.port.onmessage = (e) => {
            if (e.data.type === 'samples') {
                this.bufferQueue.push(e.data.samples);
            } else if (e.data.type === 'stop') {
                this.bufferQueue = [];
                this.currentBuffer = null;
                this.currentOffset = 0;
            }
        };
    }

    process(inputs, outputs) {
        const output = outputs[0][0]; // mono output
        if (!output) return true;

        let offset = 0;
        while (offset < output.length) {
            // Need a new buffer?
            if (!this.currentBuffer || this.currentOffset >= this.currentBuffer.length) {
                if (this.bufferQueue.length > 0) {
                    this.currentBuffer = this.bufferQueue.shift();
                    this.currentOffset = 0;
                } else {
                    // Buffer underrun — fill with silence
                    for (let i = offset; i < output.length; i++) output[i] = 0;
                    break;
                }
            }

            const remaining = this.currentBuffer.length - this.currentOffset;
            const needed = output.length - offset;
            const toCopy = Math.min(remaining, needed);

            for (let i = 0; i < toCopy; i++) {
                output[offset + i] = this.currentBuffer[this.currentOffset + i];
            }

            this.currentOffset += toCopy;
            offset += toCopy;
        }

        // Report queue size for flow control
        this.port.postMessage({ type: 'status', queueSize: this.bufferQueue.length });
        return true;
    }
}

registerProcessor('nsf-processor', NSFWorkletProcessor);
