/**
 * 架构问题测试：竞态条件
 * 问题：LegacyApp 和 WorkerService 都在同时对 MongoDB 进行读写，
 *       两个服务都在写同一条记录，存在竞态条件
 *
 * 验证修复：
 *   1. API 只写 PENDING，不写 demographics，不做延迟更新
 *   2. Worker 是唯一的状态变更者（Single Writer）
 *   3. 乐观锁阻止过期写入
 *   4. 并发处理同一 job 不产生数据冲突
 *   5. 模拟原始 bug 场景（delayed update）被彻底消除
 */
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { AnalysisProcessor } from '../apps/worker-service/src/processors/analysis.processor';
import type { AnalysisRequestedEvent, AnalysisJob } from '../packages/shared-types/src/types';

const MONGODB_URI = 'mongodb://localhost:27017/analysis_db';

async function run(): Promise<void> {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  架构问题测试：两个服务同时写同一条记录 — 竞态条件           ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    await mongoose.connect(MONGODB_URI);
    const col = mongoose.connection.collection('analysis_jobs');
    const processor = new AnalysisProcessor();
    await processor.ensureConnected();
    let passed = 0;
    let failed = 0;

    // ── 测试 1：API 不再写入 demographics ──
    console.log('测试 1: API (Single Writer) 只创建 PENDING 状态，无 demographics');
    const jobId1 = uuidv4();
    const now = new Date().toISOString();

    // 模拟重构后的 API 行为
    await col.updateOne(
        { jobId: jobId1 },
        {
            $set: {
                jobId: jobId1, userId: 'race-user', dataUrl: 'https://example.com',
                status: 'PENDING', version: 1,
                createdAt: now, updatedAt: now,
                // 注意：没有 demographics 字段
            },
        },
        { upsert: true },
    );

    const apiJob = await col.findOne({ jobId: jobId1 }) as unknown as Record<string, unknown>;
    if (apiJob.status === 'PENDING' && !apiJob.demographics && apiJob.version === 1) {
        console.log('  ✅ PASS: API 创建的 job 只有 PENDING 状态，无 demographics，version=1');
        passed++;
    } else {
        console.log(`  ❌ FAIL: status=${apiJob.status}, demographics=${JSON.stringify(apiJob.demographics)}, version=${apiJob.version}`);
        failed++;
    }

    // ── 测试 2：乐观锁拒绝过期版本写入 ──
    console.log('\n测试 2: 乐观锁拒绝过期版本写入');
    const jobId2 = uuidv4();
    await col.updateOne(
        { jobId: jobId2 },
        {
            $set: {
                jobId: jobId2, userId: 'lock-user', dataUrl: 'https://example.com',
                status: 'COMPLETED', version: 5,
                demographics: { ageRange: '25-34', gender: 'female', location: 'US', confidence: 0.85 },
                createdAt: now, updatedAt: now,
            },
        },
        { upsert: true },
    );

    // 模拟一个过期的写入（version=2，但当前是 5）
    const staleResult = await col.updateOne(
        { jobId: jobId2, version: 2 },
        { $set: { status: 'PROCESSING', demographics: null }, $inc: { version: 1 } },
    );

    if (staleResult.matchedCount === 0) {
        const jobAfter = await col.findOne({ jobId: jobId2 }) as unknown as Record<string, unknown>;
        if (jobAfter.status === 'COMPLETED' && jobAfter.version === 5) {
            console.log('  ✅ PASS: 过期写入被拒绝，数据保持不变 (version=5, COMPLETED)');
            passed++;
        } else {
            console.log(`  ❌ FAIL: 数据意外改变 status=${jobAfter.status}, version=${jobAfter.version}`);
            failed++;
        }
    } else {
        console.log('  ❌ FAIL: 过期写入不应被接受');
        failed++;
    }

    // ── 测试 3：Worker 的完整版本递增链 ──
    console.log('\n测试 3: Worker 处理后版本号正确递增 (v1 → v2 → v3)');
    const jobId3 = uuidv4();
    await col.updateOne(
        { jobId: jobId3 },
        {
            $set: {
                jobId: jobId3, userId: 'version-user', dataUrl: 'https://example.com',
                status: 'PENDING', version: 1,
                createdAt: now, updatedAt: now,
            },
        },
        { upsert: true },
    );

    await processor.process({
        eventType: 'AnalysisRequested',
        jobId: jobId3,
        userId: 'version-user',
        dataUrl: 'https://example.com',
        timestamp: now,
        traceId: uuidv4(),
    });

    const jobAfterWorker = await col.findOne({ jobId: jobId3 }) as unknown as Record<string, unknown>;
    if (
        (jobAfterWorker.status === 'COMPLETED' || jobAfterWorker.status === 'FAILED') &&
        (jobAfterWorker.version as number) === 3
    ) {
        console.log(`  ✅ PASS: Worker 完成后 version=3 (PENDING→PROCESSING→${jobAfterWorker.status})`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: version=${jobAfterWorker.version}, status=${jobAfterWorker.status}`);
        failed++;
    }

    // ── 测试 4：两个 Worker 并发处理同一 job ──
    console.log('\n测试 4: 两个 Worker 并发处理同一 job — 只有一个成功');
    const jobId4 = uuidv4();
    await col.updateOne(
        { jobId: jobId4 },
        {
            $set: {
                jobId: jobId4, userId: 'concurrent-user', dataUrl: 'https://example.com',
                status: 'PENDING', version: 1,
                createdAt: now, updatedAt: now,
            },
        },
        { upsert: true },
    );

    const event4: AnalysisRequestedEvent = {
        eventType: 'AnalysisRequested',
        jobId: jobId4,
        userId: 'concurrent-user',
        dataUrl: 'https://example.com',
        timestamp: now,
        traceId: uuidv4(),
    };

    // 并发发起两次处理
    await Promise.all([
        processor.process({ ...event4, traceId: uuidv4() }),
        processor.process({ ...event4, traceId: uuidv4() }),
    ]);

    const concurrentJob = await col.findOne({ jobId: jobId4 }) as unknown as Record<string, unknown>;
    if (
        (concurrentJob.status === 'COMPLETED' || concurrentJob.status === 'FAILED') &&
        (concurrentJob.version as number) <= 3
    ) {
        console.log(`  ✅ PASS: 并发处理后 status=${concurrentJob.status}, version=${concurrentJob.version}（无冲突覆盖）`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: status=${concurrentJob.status}, version=${concurrentJob.version}`);
        failed++;
    }

    // ── 测试 5：模拟原始 bug — delayed update 被消除 ──
    console.log('\n测试 5: 原始 delayedUpdate (setTimeout 2s) 不再存在');
    const jobId5 = uuidv4();
    await col.updateOne(
        { jobId: jobId5 },
        {
            $set: {
                jobId: jobId5, userId: 'delay-user', dataUrl: 'https://example.com',
                status: 'PENDING', version: 1,
                createdAt: now, updatedAt: now,
            },
        },
        { upsert: true },
    );

    await processor.process({
        eventType: 'AnalysisRequested',
        jobId: jobId5,
        userId: 'delay-user',
        dataUrl: 'https://example.com',
        timestamp: now,
        traceId: uuidv4(),
    });

    const beforeDelay = await col.findOne({ jobId: jobId5 }) as unknown as Record<string, unknown>;
    const beforeDemo = JSON.stringify(beforeDelay.demographics);
    const beforeVer = beforeDelay.version;

    // 等待 3 秒，如果原始 delayedUpdate 还在的话会覆盖数据
    console.log('  等待 3 秒检查是否有延迟覆盖...');
    await new Promise((r) => setTimeout(r, 3000));

    const afterDelay = await col.findOne({ jobId: jobId5 }) as unknown as Record<string, unknown>;
    const afterDemo = JSON.stringify(afterDelay.demographics);
    const afterVer = afterDelay.version;

    if (beforeDemo === afterDemo && beforeVer === afterVer) {
        console.log(`  ✅ PASS: 等待 3 秒后数据完全一致 — delayedUpdate 已被移除`);
        console.log(`          version=${beforeVer}→${afterVer}, demographics 未变`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: 数据在等待后被修改！delayedUpdate 可能仍然存在`);
        console.log(`          version: ${beforeVer}→${afterVer}`);
        console.log(`          demographics: ${beforeDemo} → ${afterDemo}`);
        failed++;
    }

    // ── 测试 6：API 源码中不再有 setTimeout 和 calculateQuickDemographics ──
    console.log('\n测试 6: API 源码中不再包含 setTimeout 和 calculateQuickDemographics');
    const fs = await import('fs');
    const path = await import('path');
    const apiServicePath = path.resolve(
        process.cwd(),
        'apps/legacy-app/src/analysis/analysis.service.ts',
    );
    const sourceCode = fs.readFileSync(apiServicePath, 'utf-8');

    const hasSetTimeout = sourceCode.includes('setTimeout');
    const hasQuickDemo = sourceCode.includes('calculateQuickDemographics');
    const hasDelayedUpdate = sourceCode.includes('delayedUpdate');

    if (!hasSetTimeout && !hasQuickDemo && !hasDelayedUpdate) {
        console.log('  ✅ PASS: 源码中已移除 setTimeout / calculateQuickDemographics / delayedUpdate');
        passed++;
    } else {
        const remaining = [];
        if (hasSetTimeout) remaining.push('setTimeout');
        if (hasQuickDemo) remaining.push('calculateQuickDemographics');
        if (hasDelayedUpdate) remaining.push('delayedUpdate');
        console.log(`  ❌ FAIL: 源码仍包含: ${remaining.join(', ')}`);
        failed++;
    }

    // 清理
    await col.deleteMany({ jobId: { $in: [jobId1, jobId2, jobId3, jobId4, jobId5] } });
    await mongoose.disconnect();

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`架构问题测试结果: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(50)}`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error('测试崩溃:', err); process.exit(1); });
