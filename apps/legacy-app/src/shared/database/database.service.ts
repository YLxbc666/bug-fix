import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import mongoose, { Connection } from 'mongoose';
import type { AnalysisJob } from '@senior-challenge/shared-types';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/analysis_db';

@Injectable()
export class DatabaseService implements OnModuleInit {
    private readonly logger = new Logger(DatabaseService.name);
    private connection: Connection | null = null;

    async onModuleInit(): Promise<void> {
        try {
            await mongoose.connect(MONGODB_URI);
            this.connection = mongoose.connection;
            this.logger.log('Connected to MongoDB');
        } catch (error) {
            this.logger.error('Failed to connect to MongoDB', error);
            throw error;
        }
    }

    private getCollection() {
        const collection = this.connection?.collection('analysis_jobs');
        if (!collection) {
            throw new Error('Database not connected');
        }
        return collection;
    }

    async saveJob(job: AnalysisJob): Promise<void> {
        const collection = this.getCollection();
        const jobWithVersion = { ...job, version: 1 };

        await collection.updateOne(
            { jobId: job.jobId },
            { $set: jobWithVersion },
            { upsert: true },
        );
    }

    async findJobById(jobId: string): Promise<AnalysisJob | null> {
        const collection = this.getCollection();
        const doc = await collection.findOne({ jobId });
        return doc as unknown as AnalysisJob | null;
    }

    /**
     * Optimistic-lock update: only succeeds when the current document
     * version matches `expectedVersion`. Increments version on success.
     * Returns true if the update was applied.
     */
    async updateJobWithVersion(
        jobId: string,
        updates: Partial<AnalysisJob>,
        expectedVersion: number,
    ): Promise<boolean> {
        const collection = this.getCollection();

        const result = await collection.updateOne(
            { jobId, version: expectedVersion },
            {
                $set: { ...updates, updatedAt: new Date().toISOString() },
                $inc: { version: 1 },
            },
        );

        if (result.matchedCount === 0) {
            this.logger.warn(
                `Optimistic lock conflict for job ${jobId}: expected version ${expectedVersion}`,
            );
            return false;
        }
        return true;
    }
}
