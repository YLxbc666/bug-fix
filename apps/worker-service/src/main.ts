import { QueuePoller } from './queue-poller';
import { AnalysisProcessor } from './processors/analysis.processor';

async function main(): Promise<void> {
    console.log('[WorkerService] Starting...');

    const processor = new AnalysisProcessor();
    await processor.ensureConnected();

    const poller = new QueuePoller(processor);

    const shutdown = () => {
        console.log('[WorkerService] Shutting down...');
        poller.stop();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await poller.start();
}

main().catch((error) => {
    console.error('[WorkerService] Fatal error:', error);
    process.exit(1);
});
