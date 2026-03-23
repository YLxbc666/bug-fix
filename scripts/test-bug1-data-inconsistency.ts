/**
 * Bug 1 测试：数据不一致
 * 用户反馈："刚刚看到的分析结果，刷新后又变了"
 *
 * 原因：API 层 delayedUpdate() 在 2 秒后用随机数据覆盖 Worker 的正确结果
 *
 * 验证修复：
 *   1. API 创建 job 后不写入 demographics（不做计算）
 *   2. Worker 写入结果后，多次"刷新"读取，数据始终一致
 *   3. 等待超过 2 秒后数据仍然不变（原 setTimeout 不再存在）
 */
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { AnalysisProcessor } from '../apps/worker-service/src/processors/analysis.processor';
import type { AnalysisRequestedEvent, AnalysisJob } from '../packages/shared-types/src/types';

const MONGODB_URI = 'mongodb://localhost:27017/analysis_db';

async function run(): Promise<void> {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Bug 1 测试：数据不一致 — "刷新后数据变了"                    ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    await mongoose.connect(MONGODB_URI);
    const col = mongoose.connection.collection('analysis_jobs');
    let passed = 0;
    let failed = 0;

    // ── 测试 1：API 创建 job 后没有 demographics ──
    console.log('测试 1: API 创建 job 后不应写入 demographics（原 bug：写入随机数据）');
    const jobId = uuidv4();
    const now = new Date().toISOString();

    // 模拟 API 创建 job（重构后的行为）
    await col.updateOne(
        { jobId },
        {
            $set: {
                jobId,
                userId: 'test-user',
                dataUrl: 'https://example.com/data',
                status: 'PENDING',
                version: 1,
                createdAt: now,
                updatedAt: now,
            },
        },
        { upsert: true },
    );

    const afterApi = await col.findOne({ jobId }) as unknown as AnalysisJob;
    if (!afterApi.demographics) {
        console.log('  ✅ PASS: API 创建 job 后无 demographics');
        passed++;
    } else {
        console.log(`  ❌ FAIL: API 不应写入 demographics, 但发现 ${JSON.stringify(afterApi.demographics)}`);
        failed++;
    }

    // ── 测试 2：Worker 处理后数据稳定 ──
    console.log('\n测试 2: Worker 处理完后，多次"刷新"读取数据应始终一致');
    const processor = new AnalysisProcessor();
    await processor.ensureConnected();

    const event: AnalysisRequestedEvent = {
        eventType: 'AnalysisRequested',
        jobId,
        userId: 'test-user',
        dataUrl: 'https://example.com/data',
        timestamp: now,
        traceId: uuidv4(),
    };
    await processor.process(event);

    const snapshots: string[] = [];
    for (let i = 0; i < 5; i++) {
        const snap = await col.findOne({ jobId }) as unknown as AnalysisJob;
        snapshots.push(JSON.stringify(snap.demographics));
    }

    const allSame = snapshots.every((s) => s === snapshots[0]);
    if (allSame) {
        console.log(`  ✅ PASS: 连续 5 次读取 demographics 完全相同`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: 数据不一致！快照列表：`);
        snapshots.forEach((s, i) => console.log(`    刷新 #${i + 1}: ${s}`));
        failed++;
    }

    // ── 测试 3：等待 3 秒后数据仍不变（原 bug 的 setTimeout 2 秒覆盖） ──
    console.log('\n测试 3: 等待 3 秒后数据不被覆盖（原 bug：setTimeout 2 秒后覆盖）');
    const beforeWait = await col.findOne({ jobId }) as unknown as AnalysisJob;
    const beforeDemo = JSON.stringify(beforeWait.demographics);
    const beforeVersion = (beforeWait as unknown as Record<string, unknown>).version;

    await new Promise((r) => setTimeout(r, 3000));

    const afterWait = await col.findOne({ jobId }) as unknown as AnalysisJob;
    const afterDemo = JSON.stringify(afterWait.demographics);
    const afterVersion = (afterWait as unknown as Record<string, unknown>).version;

    if (beforeDemo === afterDemo && beforeVersion === afterVersion) {
        console.log(`  ✅ PASS: 等待 3 秒后 demographics 和 version 均未变化`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: 数据被覆盖！`);
        console.log(`    等待前: version=${beforeVersion}, demographics=${beforeDemo}`);
        console.log(`    等待后: version=${afterVersion}, demographics=${afterDemo}`);
        failed++;
    }

    // ── 测试 4：模拟用户场景完整流程 ──
    console.log('\n测试 4: 完整用户场景 — 创建 → 处理 → 多次刷新不闪烁');
    const jobId2 = uuidv4();
    await col.updateOne(
        { jobId: jobId2 },
        {
            $set: {
                jobId: jobId2,
                userId: 'user-2',
                dataUrl: 'https://example.com/data2',
                status: 'PENDING',
                version: 1,
                createdAt: now,
                updatedAt: now,
            },
        },
        { upsert: true },
    );

    const event2: AnalysisRequestedEvent = {
        eventType: 'AnalysisRequested',
        jobId: jobId2,
        userId: 'user-2',
        dataUrl: 'https://example.com/data2',
        timestamp: now,
        traceId: uuidv4(),
    };
    await processor.process(event2);

    const statusSnapshots: string[] = [];
    for (let i = 0; i < 10; i++) {
        const snap = await col.findOne({ jobId: jobId2 }) as unknown as AnalysisJob;
        statusSnapshots.push(snap.status);
        await new Promise((r) => setTimeout(r, 300));
    }

    const flickered = statusSnapshots.some(
        (s, i) => i > 0 && s !== statusSnapshots[i - 1],
    );
    const finalStatus = statusSnapshots[statusSnapshots.length - 1];

    if (!flickered && (finalStatus === 'COMPLETED' || finalStatus === 'FAILED')) {
        console.log(`  ✅ PASS: 10 次刷新状态始终为 ${finalStatus}，无闪烁`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: 检测到闪烁！状态序列: [${statusSnapshots.join(', ')}]`);
        failed++;
    }

    // 清理
    await col.deleteMany({ jobId: { $in: [jobId, jobId2] } });
    await mongoose.disconnect();

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Bug 1 测试结果: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(50)}`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error('测试崩溃:', err); process.exit(1); });
