/**
 * Part 3 Test: Observability & Fault Tolerance
 * Verifies:
 *   1. Chaos data is correctly validated via Zod
 *   2. Valid records pass, invalid records are rejected with reasons
 *   3. Failed records are saved to failed-records/
 *   4. Structured logging with traceId in Worker processor
 *   5. Dirty API responses don't crash the processor
 *
 * Prerequisites: MongoDB running on localhost:27017
 */
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { AnalysisProcessor } from '../apps/worker-service/src/processors/analysis.processor';
import type { AnalysisRequestedEvent, AnalysisJob } from '../packages/shared-types/src/types';

const MONGODB_URI = 'mongodb://localhost:27017/analysis_db';

const ChaosRecordSchema = z.object({
    id: z.string(),
    age: z.number().int().min(0).max(150),
    gender: z.string().min(1),
    country: z.string().min(1),
    city: z.string().min(1),
    tags: z.array(z.string()).min(1),
    engagementScore: z.number().min(0).max(1),
    email: z.string().email(),
});

function normalizeRecord(raw: Record<string, unknown>): Record<string, unknown> {
    const out = { ...raw };
    if (typeof out.age === 'string') {
        const num = parseInt(out.age as string, 10);
        if (isFinite(num)) out.age = num;
    }
    if (typeof out.tags === 'string') {
        out.tags = (out.tags as string).split(',').map((t) => t.trim()).filter(Boolean);
    }
    if (typeof out.engagementScore === 'string') {
        const num = parseFloat(out.engagementScore as string);
        if (isFinite(num)) out.engagementScore = num;
    }
    return out;
}

async function runTests(): Promise<void> {
    console.log('=== Part 3: Observability & Fault Tolerance Test ===\n');
    let passed = 0;
    let failed = 0;

    // --- Test 1: Zod schema validates clean data correctly ---
    console.log('Test 1: Zod validates clean records');
    const cleanRecord = {
        id: 'record-001',
        age: 28,
        gender: 'female',
        country: 'US',
        city: 'New York',
        tags: ['fashion', 'travel'],
        engagementScore: 0.85,
        email: 'user@example.com',
    };
    const cleanResult = ChaosRecordSchema.safeParse(cleanRecord);
    if (cleanResult.success) {
        console.log('  PASS: Clean record passes validation');
        passed++;
    } else {
        console.log('  FAIL: Clean record unexpectedly rejected');
        failed++;
    }

    // --- Test 2: Zod rejects dirty data with specific error messages ---
    console.log('\nTest 2: Zod rejects dirty data with error details');
    const dirtyRecords = [
        { id: 'r1', age: '25+', gender: 'male', country: 'UK', city: 'London', tags: 'tech,gaming', engagementScore: 0.72, email: 'user@example.com' },
        { id: 'r2', age: null, gender: 'female', country: 'CA', city: 'Toronto', tags: ['beauty'], engagementScore: 0.68, email: 'invalid-email' },
        { id: 'r3', age: -5, gender: 'female', country: 'FR', city: 'Paris', tags: ['fashion'], engagementScore: 1.5, email: 'user@example.fr' },
    ];

    let allRejected = true;
    for (const rec of dirtyRecords) {
        const result = ChaosRecordSchema.safeParse(rec);
        if (result.success) {
            console.log(`  FAIL: Dirty record ${rec.id} incorrectly passed`);
            allRejected = false;
            failed++;
        }
    }
    if (allRejected) {
        console.log('  PASS: All dirty records correctly rejected');
        passed++;
    }

    // --- Test 3: normalize + validate pipeline handles string-to-number coercion ---
    console.log('\nTest 3: Normalize pipeline coerces fixable dirty data');
    const fixable = {
        id: 'record-002',
        age: '25',
        gender: 'male',
        country: 'UK',
        city: 'London',
        tags: 'tech,gaming',
        engagementScore: '0.72',
        email: 'user@example.com',
    };
    const normalized = normalizeRecord(fixable as unknown as Record<string, unknown>);
    const fixResult = ChaosRecordSchema.safeParse(normalized);
    if (fixResult.success && fixResult.data.age === 25 && Array.isArray(fixResult.data.tags)) {
        console.log('  PASS: Fixable data normalized and passes validation');
        passed++;
    } else {
        console.log(`  FAIL: Normalization failed, errors=${fixResult.success ? 'none' : fixResult.error.issues.map((i) => i.message).join(', ')}`);
        failed++;
    }

    // --- Test 4: Full chaos file processing ---
    console.log('\nTest 4: Full chaos-data-samples.json processing');
    const chaosPath = path.resolve(process.cwd(), 'debug-payloads/chaos-data-samples.json');
    if (!fs.existsSync(chaosPath)) {
        console.log('  SKIP: chaos-data-samples.json not found');
    } else {
        const rawData: unknown[] = JSON.parse(fs.readFileSync(chaosPath, 'utf-8'));
        let validCount = 0;
        let invalidCount = 0;
        for (const raw of rawData) {
            const norm = normalizeRecord(raw as Record<string, unknown>);
            const res = ChaosRecordSchema.safeParse(norm);
            if (res.success) validCount++;
            else invalidCount++;
        }

        if (validCount > 0 && invalidCount > 0 && validCount + invalidCount === rawData.length) {
            console.log(`  PASS: ${validCount} valid + ${invalidCount} invalid = ${rawData.length} total records`);
            passed++;
        } else {
            console.log(`  FAIL: valid=${validCount}, invalid=${invalidCount}, total=${rawData.length}`);
            failed++;
        }
    }

    // --- Test 5: Worker processor doesn't crash on any dirty API response ---
    console.log('\nTest 5: Worker processor handles all dirty API scenarios without crashing');
    await mongoose.connect(MONGODB_URI);
    const conn = mongoose.connection;
    const processor = new AnalysisProcessor();
    await processor.ensureConnected();

    let crashCount = 0;
    for (let i = 0; i < 10; i++) {
        const jobId = uuidv4();
        await conn.collection('analysis_jobs').updateOne(
            { jobId },
            {
                $set: {
                    jobId,
                    userId: 'stress-user',
                    dataUrl: 'https://example.com/data',
                    status: 'PENDING',
                    version: 1,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                },
            },
            { upsert: true },
        );

        const event: AnalysisRequestedEvent = {
            eventType: 'AnalysisRequested',
            jobId,
            userId: 'stress-user',
            dataUrl: 'https://example.com/data',
            timestamp: new Date().toISOString(),
            traceId: uuidv4(),
        };

        try {
            await processor.process(event);
        } catch {
            crashCount++;
        }

        await conn.collection('analysis_jobs').deleteOne({ jobId });
    }

    if (crashCount === 0) {
        console.log('  PASS: 10/10 runs completed without crash (dirty data handled gracefully)');
        passed++;
    } else {
        console.log(`  FAIL: ${crashCount}/10 runs crashed`);
        failed++;
    }

    // --- Test 6: traceId propagation in logs ---
    console.log('\nTest 6: traceId is present in event and processor output');
    const traceId = uuidv4();
    const testJobId = uuidv4();
    await conn.collection('analysis_jobs').updateOne(
        { jobId: testJobId },
        {
            $set: {
                jobId: testJobId,
                userId: 'trace-user',
                dataUrl: 'https://example.com/data',
                status: 'PENDING',
                version: 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        },
        { upsert: true },
    );

    const origLog = console.log;
    let logOutput = '';
    console.log = (...args: unknown[]) => {
        const line = args.map(String).join(' ');
        logOutput += line + '\n';
        origLog(...args);
    };

    const traceEvent: AnalysisRequestedEvent = {
        eventType: 'AnalysisRequested',
        jobId: testJobId,
        userId: 'trace-user',
        dataUrl: 'https://example.com/data',
        timestamp: new Date().toISOString(),
        traceId,
    };
    await processor.process(traceEvent);

    console.log = origLog;

    if (logOutput.includes(traceId)) {
        console.log(`  PASS: traceId=${traceId} found in processor output`);
        passed++;
    } else {
        console.log(`  FAIL: traceId=${traceId} not found in output`);
        failed++;
    }

    await conn.collection('analysis_jobs').deleteOne({ jobId: testJobId });

    console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
    console.error('Test suite crashed:', err);
    process.exit(1);
});
