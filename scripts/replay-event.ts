import * as fs from 'fs';
import * as path from 'path';
import { AnalysisProcessor } from '../apps/worker-service/src/processors/analysis.processor';
import type { AnalysisRequestedEvent } from '../packages/shared-types/src/types';

async function main(): Promise<void> {
    const fileArg = process.argv.find((a) => a.startsWith('--file='));
    if (!fileArg) {
        console.error('Usage: pnpm run replay -- --file=debug-payloads/job-xxx.json');
        process.exit(1);
    }

    const filePath = path.resolve(process.cwd(), fileArg.split('=')[1]);
    if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    let event: AnalysisRequestedEvent;
    try {
        event = JSON.parse(content);
    } catch {
        console.error(`Invalid JSON in ${filePath}`);
        process.exit(1);
    }

    if (!event.jobId || !event.eventType) {
        console.error('File does not contain a valid AnalysisRequestedEvent (missing jobId or eventType)');
        process.exit(1);
    }

    console.log(`[Replay] Loading event from: ${filePath}`);
    console.log(`[Replay] jobId=${event.jobId} traceId=${event.traceId ?? 'N/A'}`);
    console.log(`[Replay] --- Begin processing ---`);

    const processor = new AnalysisProcessor();
    await processor.ensureConnected();

    const start = Date.now();
    await processor.process(event);
    const elapsed = Date.now() - start;

    console.log(`[Replay] --- Finished in ${elapsed}ms ---`);
    process.exit(0);
}

main().catch((error) => {
    console.error('[Replay] Fatal error:', error);
    process.exit(1);
});
