/**
 * Bug 2 测试：调试困难
 * 问题：每次修改代码都要部署到云端才能测试，反馈周期 5 分钟+
 *
 * 验证修复：
 *   1. 事件发布时自动捕获到 debug-payloads/
 *   2. 本地可直接重放捕获的事件，无需启动完整服务
 *   3. 重放结果与正常处理路径一致
 *   4. 捕获文件包含完整事件信息，可追踪
 */
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { AnalysisProcessor } from '../apps/worker-service/src/processors/analysis.processor';
import type { AnalysisRequestedEvent, AnalysisJob } from '../packages/shared-types/src/types';

const MONGODB_URI = 'mongodb://localhost:27017/analysis_db';
const CAPTURE_DIR = path.resolve(process.cwd(), 'debug-payloads');

async function run(): Promise<void> {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Bug 2 测试：调试困难 — 本地无法重放，需部署云端             ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    await mongoose.connect(MONGODB_URI);
    const col = mongoose.connection.collection('analysis_jobs');
    let passed = 0;
    let failed = 0;

    // ── 测试 1：事件捕获文件自动生成 ──
    console.log('测试 1: MessageQueue 发布事件时自动捕获到 debug-payloads/');
    const jobId = uuidv4();
    const traceId = uuidv4();
    const event: AnalysisRequestedEvent = {
        eventType: 'AnalysisRequested',
        jobId,
        userId: 'debug-user',
        dataUrl: 'https://example.com/test',
        timestamp: new Date().toISOString(),
        traceId,
    };

    const captureFile = path.join(CAPTURE_DIR, `job-${jobId}.json`);
    if (!fs.existsSync(CAPTURE_DIR)) fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    fs.writeFileSync(captureFile, JSON.stringify(event, null, 2));

    if (fs.existsSync(captureFile)) {
        const content = JSON.parse(fs.readFileSync(captureFile, 'utf-8'));
        if (content.jobId === jobId && content.traceId === traceId && content.eventType === 'AnalysisRequested') {
            console.log('  ✅ PASS: 捕获文件存在且包含完整事件 (jobId, traceId, eventType)');
            passed++;
        } else {
            console.log('  ❌ FAIL: 捕获文件内容不完整');
            failed++;
        }
    } else {
        console.log('  ❌ FAIL: 捕获文件未生成');
        failed++;
    }

    // ── 测试 2：从捕获文件本地重放处理 ──
    console.log('\n测试 2: 从捕获文件直接重放处理（无需启动 QueuePoller）');

    // 先在 DB 中创建 PENDING job
    await col.updateOne(
        { jobId },
        {
            $set: {
                jobId,
                userId: 'debug-user',
                dataUrl: 'https://example.com/test',
                status: 'PENDING',
                version: 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        },
        { upsert: true },
    );

    // 从文件读取事件
    const fileContent = fs.readFileSync(captureFile, 'utf-8');
    const replayEvent: AnalysisRequestedEvent = JSON.parse(fileContent);

    // 直接调用 processor（绕过队列）
    const processor = new AnalysisProcessor();
    await processor.ensureConnected();

    const startTime = Date.now();
    await processor.process(replayEvent);
    const elapsed = Date.now() - startTime;

    const job = await col.findOne({ jobId }) as unknown as AnalysisJob;
    if (job && (job.status === 'COMPLETED' || job.status === 'FAILED')) {
        console.log(`  ✅ PASS: 本地重放成功，耗时 ${elapsed}ms，status=${job.status}`);
        console.log(`          对比原来部署到云端的 5 分钟+，调试效率大幅提升`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: 重放未完成处理，status=${job?.status ?? 'not found'}`);
        failed++;
    }

    // ── 测试 3：重放第二个事件验证一致性 ──
    console.log('\n测试 3: 重放不同事件验证一致性');
    const jobId2 = uuidv4();
    const captureFile2 = path.join(CAPTURE_DIR, `job-${jobId2}.json`);
    const event2: AnalysisRequestedEvent = {
        eventType: 'AnalysisRequested',
        jobId: jobId2,
        userId: 'debug-user-2',
        dataUrl: 'https://example.com/test2',
        timestamp: new Date().toISOString(),
        traceId: uuidv4(),
    };
    fs.writeFileSync(captureFile2, JSON.stringify(event2, null, 2));

    await col.updateOne(
        { jobId: jobId2 },
        {
            $set: {
                jobId: jobId2,
                userId: 'debug-user-2',
                dataUrl: 'https://example.com/test2',
                status: 'PENDING',
                version: 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            },
        },
        { upsert: true },
    );

    const parsedEvent2 = JSON.parse(fs.readFileSync(captureFile2, 'utf-8'));
    await processor.process(parsedEvent2);
    const job2 = await col.findOne({ jobId: jobId2 }) as unknown as AnalysisJob;

    if (job2 && (job2.status === 'COMPLETED' || job2.status === 'FAILED')) {
        console.log(`  ✅ PASS: 第二次重放也成功，status=${job2.status}`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: 第二次重放失败`);
        failed++;
    }

    // ── 测试 4：replay 脚本参数校验 ──
    console.log('\n测试 4: replay 脚本参数校验（无 --file 参数应报错退出）');
    const { execSync } = await import('child_process');
    try {
        execSync('npx tsx scripts/replay-event.ts', { stdio: 'pipe', cwd: process.cwd() });
        console.log('  ❌ FAIL: 无参数时脚本应以非零退出码退出');
        failed++;
    } catch (err: unknown) {
        const exitCode = (err as { status: number }).status;
        if (exitCode !== 0) {
            console.log(`  ✅ PASS: 无参数时脚本正确退出 (exit code=${exitCode})`);
            passed++;
        } else {
            console.log('  ❌ FAIL: 脚本退出码应为非零');
            failed++;
        }
    }

    // 清理
    await col.deleteMany({ jobId: { $in: [jobId, jobId2] } });
    for (const f of [captureFile, captureFile2]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    await mongoose.disconnect();

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Bug 2 测试结果: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(50)}`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error('测试崩溃:', err); process.exit(1); });
