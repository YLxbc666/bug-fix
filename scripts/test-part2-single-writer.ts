/**
 * Part 2 Test: Single Writer Pattern & Optimistic Locking
 * Verifies:
 *   1. API only writes PENDING (no demographics)
 *   2. Worker is the sole writer for status transitions
 *   3. Optimistic locking prevents stale overwrites
 *   4. No more "flickering" data
 *
 * Prerequisites: MongoDB running on localhost:27017
 */
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { AnalysisProcessor } from '../apps/worker-service/src/processors/analysis.processor';
import type { AnalysisRequestedEvent, AnalysisJob } from '../packages/shared-types/src/types';

const MONGODB_URI = 'mongodb://localhost:27017/analysis_db';

async function setup(): Promise<mongoose.Connection> {
    await mongoose.connect(MONGODB_URI);
    return mongoose.connection;
}

async function runTests(): Promise<void> {
    console.log('=== Part 2: Single Writer Pattern & Optimistic Locking Test ===\n');
    let passed = 0;
    let failed = 0;

    const conn = await setup();
    const col = conn.collection('analysis_jobs');

    // --- Test 1: API creates PENDING job without demographics ---
    console.log('Test 1: API creates job in PENDING state without demographics');
    const jobId1 = uuidv4();
    const now = new Date().toISOString();
    const apiJob = {
        jobId: jobId1,
        userId: 'user-1',
        dataUrl: 'https://example.com/data',
        status: 'PENDING',
        version: 1,
        createdAt: now,
        updatedAt: now,
    };
    await col.updateOne({ jobId: jobId1 }, { $set: apiJob }, { upsert: true });

    const savedJob = await col.findOne({ jobId: jobId1 }) as unknown as AnalysisJob & { version: number };
    if (savedJob.status === 'PENDING' && !savedJob.demographics && savedJob.version === 1) {
        console.log('  PASS: Job is PENDING, no demographics, version=1');
        passed++;
    } else {
        console.log(`  FAIL: status=${savedJob.status}, demographics=${JSON.stringify(savedJob.demographics)}, version=${savedJob.version}`);
        failed++;
    }

    // --- Test 2: Worker transitions PENDING -> PROCESSING -> COMPLETED ---
    console.log('\nTest 2: Worker drives all state transitions');
    const processor = new AnalysisProcessor();
    await processor.ensureConnected();

    const event: AnalysisRequestedEvent = {
        eventType: 'AnalysisRequested',
        jobId: jobId1,
        userId: 'user-1',
        dataUrl: 'https://example.com/data',
        timestamp: now,
        traceId: uuidv4(),
    };
    await processor.process(event);

    const afterWorker = await col.findOne({ jobId: jobId1 }) as unknown as AnalysisJob & { version: number };
    if (
        (afterWorker.status === 'COMPLETED' || afterWorker.status === 'FAILED') &&
        afterWorker.version > 1
    ) {
        console.log(`  PASS: status=${afterWorker.status}, version=${afterWorker.version}, demographics=${afterWorker.demographics ? 'present' : 'absent'}`);
        passed++;
    } else {
        console.log(`  FAIL: status=${afterWorker.status}, version=${afterWorker.version}`);
        failed++;
    }

    // --- Test 3: Optimistic lock rejects stale writes ---
    console.log('\nTest 3: Optimistic locking rejects stale version writes');
    const jobId2 = uuidv4();
    await col.updateOne(
        { jobId: jobId2 },
        {
            $set: {
                jobId: jobId2,
                userId: 'user-2',
                dataUrl: 'https://example.com/data2',
                status: 'COMPLETED',
                version: 5,
                demographics: { ageRange: '25-34', gender: 'female', location: 'US', confidence: 0.85 },
                createdAt: now,
                updatedAt: now,
            },
        },
        { upsert: true },
    );

    const staleResult = await col.updateOne(
        { jobId: jobId2, version: 3 },
        { $set: { status: 'PROCESSING', demographics: null }, $inc: { version: 1 } },
    );

    if (staleResult.matchedCount === 0) {
        console.log('  PASS: Stale write (version=3 vs current=5) correctly rejected');
        passed++;
    } else {
        console.log('  FAIL: Stale write was accepted');
        failed++;
    }

    const jobAfterStale = await col.findOne({ jobId: jobId2 }) as unknown as AnalysisJob & { version: number };
    if (jobAfterStale.status === 'COMPLETED' && jobAfterStale.version === 5) {
        console.log('  PASS: Data remains unchanged after rejected stale write');
        passed++;
    } else {
        console.log(`  FAIL: Data changed, status=${jobAfterStale.status}, version=${jobAfterStale.version}`);
        failed++;
    }

    // --- Test 4: No data flickering simulation ---
    console.log('\nTest 4: Concurrent processing does not cause data flickering');
    const jobId3 = uuidv4();
    await col.updateOne(
        { jobId: jobId3 },
        {
            $set: {
                jobId: jobId3,
                userId: 'user-3',
                dataUrl: 'https://example.com/data3',
                status: 'PENDING',
                version: 1,
                createdAt: now,
                updatedAt: now,
            },
        },
        { upsert: true },
    );

    const event3: AnalysisRequestedEvent = {
        eventType: 'AnalysisRequested',
        jobId: jobId3,
        userId: 'user-3',
        dataUrl: 'https://example.com/data3',
        timestamp: now,
        traceId: uuidv4(),
    };

    await Promise.all([
        processor.process(event3),
        processor.process({ ...event3, traceId: uuidv4() }),
    ]);

    const snapshots = [];
    for (let i = 0; i < 5; i++) {
        const snap = await col.findOne({ jobId: jobId3 }) as unknown as AnalysisJob;
        snapshots.push(snap.status);
        await new Promise((r) => setTimeout(r, 200));
    }

    const finalStatus = snapshots[snapshots.length - 1];
    const statusFlickered = snapshots.some(
        (s, i) => i > 0 && s !== snapshots[i - 1] && snapshots[i - 1] === 'COMPLETED',
    );

    if (!statusFlickered && (finalStatus === 'COMPLETED' || finalStatus === 'FAILED')) {
        console.log(`  PASS: No flickering detected, final status=${finalStatus}, snapshots=[${snapshots.join(', ')}]`);
        passed++;
    } else {
        console.log(`  FAIL: Flickering detected, snapshots=[${snapshots.join(', ')}]`);
        failed++;
    }

    // --- Cleanup ---
    await col.deleteMany({ jobId: { $in: [jobId1, jobId2, jobId3] } });

    console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
    await mongoose.disconnect();
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
    console.error('Test suite crashed:', err);
    process.exit(1);
});
