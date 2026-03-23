import * as fs from 'fs';
import * as path from 'path';
import type { AnalysisRequestedEvent } from '@senior-challenge/shared-types';
import type { MessageProcessor } from './processors/processor.interface';

const QUEUE_DIR = path.join(process.cwd(), 'local-queue');
const FAILED_DIR = path.join(process.cwd(), 'failed-records');
const POLL_INTERVAL_MS = 1000;

export class QueuePoller {
    private isRunning = false;

    constructor(private readonly processor: MessageProcessor) { }

    async start(): Promise<void> {
        for (const dir of [QUEUE_DIR, FAILED_DIR]) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }

        console.log(`[QueuePoller] Started, watching: ${QUEUE_DIR}`);
        this.isRunning = true;
        await this.pollLoop();
    }

    stop(): void {
        this.isRunning = false;
    }

    private async pollLoop(): Promise<void> {
        while (this.isRunning) {
            try {
                const files = fs.readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.json'));

                for (const file of files) {
                    const filepath = path.join(QUEUE_DIR, file);

                    try {
                        const content = fs.readFileSync(filepath, 'utf-8');
                        const event: AnalysisRequestedEvent = JSON.parse(content);
                        const tag = `[jobId=${event.jobId} traceId=${event.traceId ?? 'N/A'}]`;

                        console.log(`${tag} Dequeued message from ${file}`);

                        await this.processor.process(event);

                        fs.unlinkSync(filepath);
                        console.log(`${tag} Message processed and deleted: ${file}`);
                    } catch (error) {
                        const errMsg = error instanceof Error ? error.message : String(error);
                        console.error(
                            `[QueuePoller] Error processing file=${file}: ${errMsg}`,
                            error,
                        );
                        this.moveToFailed(filepath, file, error);
                    }
                }
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                console.error(`[QueuePoller] Poll loop error: ${errMsg}`, error);
            }

            await this.sleep(POLL_INTERVAL_MS);
        }
    }

    private moveToFailed(filepath: string, filename: string, error: unknown): void {
        try {
            const failedPath = path.join(FAILED_DIR, `${Date.now()}-${filename}`);
            const content = fs.existsSync(filepath) ? fs.readFileSync(filepath, 'utf-8') : '{}';
            const failedRecord = {
                originalMessage: JSON.parse(content),
                error: error instanceof Error ? error.message : String(error),
                failedAt: new Date().toISOString(),
            };
            fs.writeFileSync(failedPath, JSON.stringify(failedRecord, null, 2));
            if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
        } catch {
            console.error(`[QueuePoller] Could not move ${filename} to failed-records/`);
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
