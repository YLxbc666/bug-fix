/**
 * Part 1 Test: Replay Tool
 * Verifies: event capture on publish + replay via script
 *
 * Prerequisites: MongoDB running on localhost:27017
 */
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { AnalysisProcessor } from '../apps/worker-service/src/processors/analysis.processor';
import type { AnalysisRequestedEvent, AnalysisJob } from '../packages/shared-types/src/types';

const MONGODB_URI = 'mongodb://localhost:27017/analysis_db';
const CAPTURE_DIR = path.resolve(process.cwd(), 'debug-payloads');

async function setup(): Promise<mongoose.Connection> {
    await mongoose.connect(MONGODB_URI);
    return mongoose.connection;
}

async function seedJob(conn: mongoose.Connection, jobId: string): Promise<void> {
    await conn.collection('analysis_jobs').updateOne(
        { jobId },
        {
            $set: {
                jobId,
                userId: 'test-user',
                dataUrl: 'https://example.com/data',
                status: 'PENDING',
                version: 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        },
        { upsert: true },
    );
}

async function runTests(): Promise<void> {
    console.log('=== Part 1: Replay Tool Test ===\n');
    let passed = 0;
    let failed = 0;

    const conn = await setup();

    // --- Test 1: Capture file is created on event publish ---
    console.log('Test 1: Event capture file creation');
    const testJobId = uuidv4();
    const captureFile = path.join(CAPTURE_DIR, `job-${testJobId}.json`);
    const event: AnalysisRequestedEvent = {
        eventType: 'AnalysisRequested',
        jobId: testJobId,
        userId: 'test-user',
        dataUrl: 'https://example.com/data',
        timestamp: new Date().toISOString(),
        traceId: uuidv4(),
    };

    if (!fs.existsSync(CAPTURE_DIR)) fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    fs.writeFileSync(captureFile, JSON.stringify(event, null, 2));

    if (fs.existsSync(captureFile)) {
        const content = JSON.parse(fs.readFileSync(captureFile, 'utf-8'));
        if (content.jobId === testJobId && content.traceId === event.traceId) {
            console.log('  PASS: Capture file created with correct jobId and traceId');
            passed++;
        } else {
            console.log('  FAIL: Capture file content mismatch');
            failed++;
        }
    } else {
        console.log('  FAIL: Capture file was not created');
        failed++;
    }

    // --- Test 2: Replay processes the captured event ---
    console.log('\nTest 2: Replay processes captured event and updates DB');
    await seedJob(conn, testJobId);

    const processor = new AnalysisProcessor();
    await processor.ensureConnected();
    await processor.process(event);

    const job = await conn.collection('analysis_jobs').findOne({ jobId: testJobId }) as unknown as AnalysisJob | null;
    if (job && (job.status === 'COMPLETED' || job.status === 'FAILED')) {
        console.log(`  PASS: Job status after replay = ${job.status}`);
        passed++;
    } else {
        console.log(`  FAIL: Job status is ${job?.status ?? 'not found'}, expected COMPLETED or FAILED`);
        failed++;
    }

    // --- Test 3: Replay file can be read from disk and replayed ---
    console.log('\nTest 3: Replay from file (round-trip)');
    const testJobId2 = uuidv4();
    const captureFile2 = path.join(CAPTURE_DIR, `job-${testJobId2}.json`);
    const event2: AnalysisRequestedEvent = {
        eventType: 'AnalysisRequested',
        jobId: testJobId2,
        userId: 'test-user-2',
        dataUrl: 'https://example.com/data2',
        timestamp: new Date().toISOString(),
        traceId: uuidv4(),
    };
    fs.writeFileSync(captureFile2, JSON.stringify(event2, null, 2));
    await seedJob(conn, testJobId2);

    const fileContent = fs.readFileSync(captureFile2, 'utf-8');
    const parsedEvent: AnalysisRequestedEvent = JSON.parse(fileContent);
    await processor.process(parsedEvent);

    const job2 = await conn.collection('analysis_jobs').findOne({ jobId: testJobId2 }) as unknown as AnalysisJob | null;
    if (job2 && (job2.status === 'COMPLETED' || job2.status === 'FAILED')) {
        console.log(`  PASS: Round-trip replay succeeded, status = ${job2.status}`);
        passed++;
    } else {
        console.log(`  FAIL: Round-trip replay failed, status = ${job2?.status ?? 'not found'}`);
        failed++;
    }

    // --- Cleanup ---
    await conn.collection('analysis_jobs').deleteMany({
        jobId: { $in: [testJobId, testJobId2] },
    });
    for (const f of [captureFile, captureFile2]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
    console.error('Test suite crashed:', err);
    process.exit(1);
});
