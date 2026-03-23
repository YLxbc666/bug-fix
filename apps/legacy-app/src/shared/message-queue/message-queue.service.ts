import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import type { AnalysisRequestedEvent } from '@senior-challenge/shared-types';

const QUEUE_DIR = path.join(process.cwd(), 'local-queue');
const CAPTURE_DIR = path.join(process.cwd(), 'debug-payloads');

@Injectable()
export class MessageQueueService {
    private readonly logger = new Logger(MessageQueueService.name);

    constructor() {
        for (const dir of [QUEUE_DIR, CAPTURE_DIR]) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
    }

    async publishEvent(event: AnalysisRequestedEvent): Promise<void> {
        const payload = JSON.stringify(event, null, 2);
        const filename = `${event.jobId}-${Date.now()}.json`;

        fs.writeFileSync(path.join(QUEUE_DIR, filename), payload);

        const captureFile = `job-${event.jobId}.json`;
        fs.writeFileSync(path.join(CAPTURE_DIR, captureFile), payload);

        this.logger.log(
            `Published event | type=${event.eventType} jobId=${event.jobId} traceId=${event.traceId ?? 'N/A'}`,
        );
    }
}
