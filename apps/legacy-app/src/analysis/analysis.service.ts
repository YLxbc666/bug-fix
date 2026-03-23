import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseService } from '../shared/database/database.service';
import { MessageQueueService } from '../shared/message-queue/message-queue.service';
import { CreateAnalysisDto } from './models/create-analysis.dto';
import type { AnalysisJob, AnalysisRequestedEvent } from '@senior-challenge/shared-types';

/**
 * Single Writer Pattern: API only creates the job in PENDING state and
 * publishes the event. All computation and status transitions happen
 * exclusively in the WorkerService, eliminating race conditions.
 */
@Injectable()
export class AnalysisService {
    private readonly logger = new Logger(AnalysisService.name);

    constructor(
        private readonly databaseService: DatabaseService,
        private readonly messageQueueService: MessageQueueService,
    ) { }

    async createAnalysis(dto: CreateAnalysisDto): Promise<AnalysisJob> {
        const jobId = uuidv4();
        const traceId = uuidv4();
        const now = new Date().toISOString();

        const job: AnalysisJob = {
            jobId,
            userId: dto.userId,
            dataUrl: dto.dataUrl,
            status: 'PENDING',
            createdAt: now,
            updatedAt: now,
        };

        await this.databaseService.saveJob(job);

        const event: AnalysisRequestedEvent = {
            eventType: 'AnalysisRequested',
            jobId,
            userId: dto.userId,
            dataUrl: dto.dataUrl,
            timestamp: now,
            traceId,
        };

        await this.messageQueueService.publishEvent(event);

        this.logger.log(
            `Job created | jobId=${jobId} traceId=${traceId} userId=${dto.userId}`,
        );

        return job;
    }

    async getAnalysisById(jobId: string): Promise<AnalysisJob | null> {
        return this.databaseService.findJobById(jobId);
    }
}
