import mongoose from 'mongoose';
import type { AnalysisRequestedEvent, AnalysisJob, Demographics, ThirdPartyApiResponse } from '@senior-challenge/shared-types';
import type { MessageProcessor } from './processor.interface';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/analysis_db';

export class AnalysisProcessor implements MessageProcessor {
    private connection: mongoose.Connection | null = null;

    async ensureConnected(): Promise<void> {
        if (this.connection?.readyState === 1) return;
        try {
            await mongoose.connect(MONGODB_URI);
            this.connection = mongoose.connection;
            console.log('[AnalysisProcessor] Connected to MongoDB');
        } catch (error) {
            console.error('[AnalysisProcessor] DB connection failed', error);
            throw error;
        }
    }

    async process(event: AnalysisRequestedEvent): Promise<void> {
        const { jobId, traceId } = event;
        const tag = `[jobId=${jobId} traceId=${traceId ?? 'N/A'}]`;

        console.log(`${tag} Processing started`);

        await this.ensureConnected();

        try {
            const job = await this.findJob(jobId);
            if (!job) {
                console.error(`${tag} Job not found in DB, skipping`);
                return;
            }

            if (job.status !== 'PENDING') {
                console.warn(`${tag} Job status is ${job.status}, expected PENDING — skipping duplicate`);
                return;
            }

            const currentVersion = job.version ?? 1;

            const updated = await this.updateJobVersioned(
                jobId,
                { status: 'PROCESSING' },
                currentVersion,
            );
            if (!updated) {
                console.warn(`${tag} Version conflict when setting PROCESSING — skipping duplicate`);
                return;
            }

            const apiResponse = await this.callThirdPartyApi(event.dataUrl);

            if (!apiResponse.success || !apiResponse.data) {
                const reason = apiResponse.error ?? 'API returned success=false or empty data';
                console.error(`${tag} Third-party API failure: ${reason}`);
                await this.updateJobVersioned(
                    jobId,
                    { status: 'FAILED', error: reason },
                    currentVersion + 1,
                );
                return;
            }

            const demographics = this.transformApiResponse(apiResponse, tag);

            const completed = await this.updateJobVersioned(
                jobId,
                {
                    status: 'COMPLETED',
                    demographics,
                    completedAt: new Date().toISOString(),
                },
                currentVersion + 1,
            );

            if (!completed) {
                console.warn(`${tag} Version conflict when setting COMPLETED`);
                return;
            }

            console.log(`${tag} Processing completed successfully`);
        } catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(`${tag} Processing failed: ${errMsg}`, error);
            try {
                await this.forceUpdateStatus(jobId, 'FAILED', errMsg);
            } catch (dbErr) {
                console.error(`${tag} Failed to mark job as FAILED in DB`, dbErr);
            }
        }
    }

    private async callThirdPartyApi(dataUrl: string): Promise<ThirdPartyApiResponse> {
        await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));

        const scenarios: ThirdPartyApiResponse[] = [
            {
                success: true,
                data: {
                    age: 28,
                    gender: 'female',
                    country: 'US',
                    city: 'New York',
                    tags: ['fashion', 'travel'],
                    score: 0.85,
                },
            },
            {
                success: true,
                data: {
                    age: '25+',
                    gender: 'male',
                    country: 'UK',
                    city: null,
                    tags: 'lifestyle,food',
                    score: '0.72',
                },
            },
            {
                success: true,
                data: {
                    age: null,
                    gender: undefined,
                    country: 'CA',
                    city: 'Toronto',
                    tags: null,
                    score: null,
                },
            },
        ];

        return scenarios[Math.floor(Math.random() * scenarios.length)];
    }

    /**
     * Robust transformer that handles all dirty-data variants the
     * third-party API may return without crashing.
     */
    private transformApiResponse(response: ThirdPartyApiResponse, tag: string): Demographics {
        const data = response.data!;

        const ageRange = this.safeParseAgeRange(data.age, tag);
        const gender = typeof data.gender === 'string' ? data.gender : 'unknown';
        const location = typeof data.country === 'string' ? data.country : 'unknown';

        let interests: string[] | undefined;
        if (Array.isArray(data.tags)) {
            interests = data.tags;
        } else if (typeof data.tags === 'string') {
            interests = data.tags.split(',').map((t: string) => t.trim()).filter(Boolean);
        }

        let confidence: number | undefined;
        if (typeof data.score === 'number' && isFinite(data.score)) {
            confidence = Math.min(1, Math.max(0, data.score));
        } else if (typeof data.score === 'string') {
            const parsed = parseFloat(data.score);
            if (isFinite(parsed)) {
                confidence = Math.min(1, Math.max(0, parsed));
            }
        }

        return { ageRange, gender, location, interests, confidence };
    }

    private safeParseAgeRange(age: unknown, tag: string): string {
        if (age === null || age === undefined) {
            console.warn(`${tag} age is missing, defaulting to 'unknown'`);
            return 'unknown';
        }

        if (typeof age === 'number' && isFinite(age) && age >= 0) {
            return this.calculateAgeRange(age);
        }

        if (typeof age === 'string') {
            const num = parseInt(age, 10);
            if (isFinite(num) && num >= 0) {
                return this.calculateAgeRange(num);
            }
            console.warn(`${tag} age is non-numeric string "${age}", using as-is`);
            return age;
        }

        console.warn(`${tag} age has unexpected type ${typeof age}, defaulting to 'unknown'`);
        return 'unknown';
    }

    private calculateAgeRange(age: number): string {
        if (age < 18) return 'under-18';
        if (age < 25) return '18-24';
        if (age < 35) return '25-34';
        if (age < 45) return '35-44';
        if (age < 55) return '45-54';
        return '55+';
    }

    private getCollection() {
        const collection = this.connection?.collection('analysis_jobs');
        if (!collection) throw new Error('Database not connected');
        return collection;
    }

    private async findJob(jobId: string): Promise<AnalysisJob | null> {
        const doc = await this.getCollection().findOne({ jobId });
        return doc as unknown as AnalysisJob | null;
    }

    private async updateJobVersioned(
        jobId: string,
        updates: Partial<AnalysisJob>,
        expectedVersion: number,
    ): Promise<boolean> {
        const result = await this.getCollection().updateOne(
            { jobId, version: expectedVersion },
            {
                $set: { ...updates, updatedAt: new Date().toISOString() },
                $inc: { version: 1 },
            },
        );
        return result.matchedCount > 0;
    }

    private async forceUpdateStatus(jobId: string, status: string, error: string): Promise<void> {
        await this.getCollection().updateOne(
            { jobId },
            { $set: { status, error, updatedAt: new Date().toISOString() } },
        );
    }
}
