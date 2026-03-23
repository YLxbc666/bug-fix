/**
 * Bug 4 测试：无法排查
 * 问题：日志里只有 "Error happened"，无法定位是哪条数据出问题
 *
 * 验证修复：
 *   1. 日志包含 jobId，可定位到具体 job
 *   2. 日志包含 traceId，可全链路追踪
 *   3. 错误日志包含具体错误信息（而非 "Error happened"）
 *   4. 脏数据降级时有明确的字段级别警告
 *   5. 日志中不再出现 "Error happened" 这样无信息的内容
 */
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { AnalysisProcessor } from '../apps/worker-service/src/processors/analysis.processor';
import type { AnalysisRequestedEvent, AnalysisJob } from '../packages/shared-types/src/types';

const MONGODB_URI = 'mongodb://localhost:27017/analysis_db';

function captureConsole(): { logs: string[]; restore: () => void } {
    const logs: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    console.log = (...args: unknown[]) => {
        const line = args.map(String).join(' ');
        logs.push(line);
        origLog(...args);
    };
    console.warn = (...args: unknown[]) => {
        const line = `[WARN] ${args.map(String).join(' ')}`;
        logs.push(line);
        origWarn(...args);
    };
    console.error = (...args: unknown[]) => {
        const line = `[ERROR] ${args.map(String).join(' ')}`;
        logs.push(line);
        origError(...args);
    };

    return {
        logs,
        restore: () => {
            console.log = origLog;
            console.warn = origWarn;
            console.error = origError;
        },
    };
}

async function run(): Promise<void> {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Bug 4 测试：无法排查 — 日志只有 "Error happened"           ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    await mongoose.connect(MONGODB_URI);
    const col = mongoose.connection.collection('analysis_jobs');
    const processor = new AnalysisProcessor();
    await processor.ensureConnected();
    let passed = 0;
    let failed = 0;

    // ── 测试 1：日志包含 jobId ──
    console.log('测试 1: 每条处理日志都包含 jobId');
    const jobId1 = uuidv4();
    await col.updateOne(
        { jobId: jobId1 },
        {
            $set: {
                jobId: jobId1, userId: 'log-user', dataUrl: 'https://example.com/data',
                status: 'PENDING', version: 1,
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            },
        },
        { upsert: true },
    );

    const capture1 = captureConsole();
    await processor.process({
        eventType: 'AnalysisRequested',
        jobId: jobId1,
        userId: 'log-user',
        dataUrl: 'https://example.com/data',
        timestamp: new Date().toISOString(),
        traceId: uuidv4(),
    });
    capture1.restore();

    const hasJobId = capture1.logs.some((l) => l.includes(jobId1));
    if (hasJobId) {
        console.log(`  ✅ PASS: 日志中包含 jobId=${jobId1}`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: 日志中未找到 jobId`);
        failed++;
    }

    // ── 测试 2：日志包含 traceId ──
    console.log('\n测试 2: 每条处理日志都包含 traceId');
    const jobId2 = uuidv4();
    const traceId2 = uuidv4();
    await col.updateOne(
        { jobId: jobId2 },
        {
            $set: {
                jobId: jobId2, userId: 'trace-user', dataUrl: 'https://example.com/data',
                status: 'PENDING', version: 1,
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            },
        },
        { upsert: true },
    );

    const capture2 = captureConsole();
    await processor.process({
        eventType: 'AnalysisRequested',
        jobId: jobId2,
        userId: 'trace-user',
        dataUrl: 'https://example.com/data',
        timestamp: new Date().toISOString(),
        traceId: traceId2,
    });
    capture2.restore();

    const hasTraceId = capture2.logs.some((l) => l.includes(traceId2));
    if (hasTraceId) {
        console.log(`  ✅ PASS: 日志中包含 traceId=${traceId2}`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: 日志中未找到 traceId`);
        failed++;
    }

    // ── 测试 3：不再出现 "Error happened" ──
    console.log('\n测试 3: 日志中不再出现无信息的 "Error happened"');
    const allLogs = [...capture1.logs, ...capture2.logs];
    const badLogs = allLogs.filter((l) =>
        l === 'Error happened' ||
        l === 'Error processing message' ||
        l === 'Error in poll loop' ||
        l === 'DB connection failed',
    );

    if (badLogs.length === 0) {
        console.log('  ✅ PASS: 没有找到无信息的错误日志');
        passed++;
    } else {
        console.log(`  ❌ FAIL: 仍然存在无信息日志: ${JSON.stringify(badLogs)}`);
        failed++;
    }

    // ── 测试 4：job not found 时错误日志包含 jobId ──
    console.log('\n测试 4: 处理不存在的 job 时错误日志包含 jobId');
    const fakeJobId = uuidv4();
    const capture4 = captureConsole();
    await processor.process({
        eventType: 'AnalysisRequested',
        jobId: fakeJobId,
        userId: 'ghost-user',
        dataUrl: 'https://example.com/data',
        timestamp: new Date().toISOString(),
        traceId: uuidv4(),
    });
    capture4.restore();

    const hasNotFoundLog = capture4.logs.some(
        (l) => l.includes(fakeJobId) && l.toLowerCase().includes('not found'),
    );
    if (hasNotFoundLog) {
        console.log(`  ✅ PASS: 不存在的 job 有明确错误日志，包含 jobId`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: 不存在 job 时缺少明确错误日志`);
        console.log(`    实际日志: ${capture4.logs.join('\n    ')}`);
        failed++;
    }

    // ── 测试 5：脏数据降级时日志包含字段信息 ──
    console.log('\n测试 5: 处理脏数据时日志包含具体字段警告');
    // 运行多次以覆盖不同脏数据场景
    const allCaptureLogs: string[] = [];
    for (let i = 0; i < 15; i++) {
        const jid = uuidv4();
        await col.updateOne(
            { jobId: jid },
            {
                $set: {
                    jobId: jid, userId: 'dirty-user', dataUrl: 'https://example.com/data',
                    status: 'PENDING', version: 1,
                    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                },
            },
            { upsert: true },
        );
        const cap = captureConsole();
        await processor.process({
            eventType: 'AnalysisRequested',
            jobId: jid,
            userId: 'dirty-user',
            dataUrl: 'https://example.com/data',
            timestamp: new Date().toISOString(),
            traceId: uuidv4(),
        });
        cap.restore();
        allCaptureLogs.push(...cap.logs);
        await col.deleteOne({ jobId: jid });
    }

    const hasFieldWarning = allCaptureLogs.some(
        (l) => l.includes('age is missing') || l.includes('age is non-numeric') || l.includes('age has unexpected'),
    );
    if (hasFieldWarning) {
        console.log('  ✅ PASS: 脏数据场景下有具体字段降级警告（如 "age is missing"）');
        passed++;
    } else {
        console.log('  ❌ FAIL: 未找到字段级别警告日志');
        failed++;
    }

    // ── 测试 6：日志格式标准化检查 ──
    console.log('\n测试 6: 日志格式标准化 [jobId=xxx traceId=xxx]');
    const structuredPattern = /\[jobId=[a-f0-9-]+ traceId=[a-f0-9-]+\]/;
    const structuredLogs = [...capture1.logs, ...capture2.logs].filter((l) => structuredPattern.test(l));

    if (structuredLogs.length >= 2) {
        console.log(`  ✅ PASS: 找到 ${structuredLogs.length} 条结构化日志，格式为 [jobId=xxx traceId=xxx]`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: 结构化日志不足 (${structuredLogs.length} 条)`);
        failed++;
    }

    // 清理
    await col.deleteMany({ jobId: { $in: [jobId1, jobId2] } });
    await mongoose.disconnect();

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Bug 4 测试结果: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(50)}`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error('测试崩溃:', err); process.exit(1); });
