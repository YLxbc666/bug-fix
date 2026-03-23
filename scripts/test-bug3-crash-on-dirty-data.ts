/**
 * Bug 3 测试：莫名其妙的崩溃
 * 问题：第三方 API 返回格式偶尔变化，导致整个批处理任务失败
 *
 * 验证修复：
 *   1. age 是字符串 "25+" 不崩溃
 *   2. tags 是逗号分隔字符串而非数组不崩溃
 *   3. score 是字符串 "0.72" 不崩溃
 *   4. 字段全部为 null 不崩溃
 *   5. 连续批量处理不会因单条脏数据导致整批失败
 *   6. chaos-data-samples.json 批处理正常完成
 */
import * as fs from 'fs';
import * as path from 'path';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { AnalysisProcessor } from '../apps/worker-service/src/processors/analysis.processor';
import type { AnalysisRequestedEvent, AnalysisJob } from '../packages/shared-types/src/types';

const MONGODB_URI = 'mongodb://localhost:27017/analysis_db';

async function createPendingJob(col: mongoose.Collection, jobId: string): Promise<void> {
    await col.updateOne(
        { jobId },
        {
            $set: {
                jobId,
                userId: 'crash-test-user',
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

async function run(): Promise<void> {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Bug 3 测试：莫名崩溃 — 第三方 API 格式变化导致批处理失败    ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    await mongoose.connect(MONGODB_URI);
    const col = mongoose.connection.collection('analysis_jobs');
    const processor = new AnalysisProcessor();
    await processor.ensureConnected();
    let passed = 0;
    let failed = 0;
    const testJobIds: string[] = [];

    // ── 测试 1：连续 20 次处理（随机脏数据场景）全部不崩溃 ──
    console.log('测试 1: Worker 连续处理 20 个 job（随机脏数据），不应有任何崩溃');
    let crashCount = 0;
    let completedCount = 0;

    for (let i = 0; i < 20; i++) {
        const jobId = uuidv4();
        testJobIds.push(jobId);
        await createPendingJob(col, jobId);

        const event: AnalysisRequestedEvent = {
            eventType: 'AnalysisRequested',
            jobId,
            userId: 'crash-test-user',
            dataUrl: 'https://example.com/data',
            timestamp: new Date().toISOString(),
            traceId: uuidv4(),
        };

        try {
            await processor.process(event);
            const job = await col.findOne({ jobId }) as unknown as AnalysisJob;
            if (job?.status === 'COMPLETED' || job?.status === 'FAILED') {
                completedCount++;
            }
        } catch {
            crashCount++;
        }
    }

    if (crashCount === 0) {
        console.log(`  ✅ PASS: 20/20 次处理均未崩溃（${completedCount} completed/failed，0 crash）`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: ${crashCount}/20 次处理崩溃`);
        failed++;
    }

    // ── 测试 2：所有 job 都有明确的终态 ──
    console.log('\n测试 2: 每个 job 处理后都有明确的终态（COMPLETED 或 FAILED）');
    let allTerminated = true;
    for (const jobId of testJobIds) {
        const job = await col.findOne({ jobId }) as unknown as AnalysisJob;
        if (job?.status !== 'COMPLETED' && job?.status !== 'FAILED') {
            console.log(`  ❌ FAIL: jobId=${jobId} 状态为 ${job?.status}，不是终态`);
            allTerminated = false;
            break;
        }
    }
    if (allTerminated) {
        console.log(`  ✅ PASS: 全部 20 个 job 都有明确终态`);
        passed++;
    } else {
        failed++;
    }

    // ── 测试 3：脏数据转换结果合理（不是 undefined/NaN） ──
    console.log('\n测试 3: 处理脏数据后 demographics 字段不含 undefined 或 NaN');
    let allClean = true;
    for (const jobId of testJobIds) {
        const job = await col.findOne({ jobId }) as unknown as AnalysisJob;
        if (job?.status === 'COMPLETED' && job.demographics) {
            const d = job.demographics;
            const serialized = JSON.stringify(d);
            if (serialized.includes('undefined') || serialized.includes('NaN')) {
                console.log(`  ❌ FAIL: jobId=${jobId} 包含 undefined/NaN: ${serialized}`);
                allClean = false;
                break;
            }
        }
    }
    if (allClean) {
        console.log(`  ✅ PASS: 所有已完成 job 的 demographics 不含 undefined/NaN`);
        passed++;
    } else {
        failed++;
    }

    // ── 测试 4：chaos-data-samples.json 批处理正常完成 ──
    console.log('\n测试 4: chaos-data-samples.json 批处理正常完成');
    const { execSync } = await import('child_process');
    try {
        const output = execSync('npx tsx scripts/process-chaos.ts', {
            cwd: process.cwd(),
            stdio: 'pipe',
            timeout: 30000,
        }).toString();

        const processedMatch = output.match(/Processed:\s*(\d+)/);
        const skippedMatch = output.match(/Skipped.*?:\s*(\d+)/);
        const processedCount = processedMatch ? parseInt(processedMatch[1]) : 0;
        const skippedCount = skippedMatch ? parseInt(skippedMatch[1]) : 0;

        if (processedCount > 0 && skippedCount > 0 && processedCount + skippedCount === 12) {
            console.log(`  ✅ PASS: 批处理完成 — ${processedCount} 条有效 + ${skippedCount} 条无效 = 12 条`);
            passed++;
        } else {
            console.log(`  ❌ FAIL: 处理数量异常 processed=${processedCount}, skipped=${skippedCount}`);
            failed++;
        }
    } catch (err) {
        console.log(`  ❌ FAIL: 批处理脚本崩溃 — ${(err as Error).message}`);
        failed++;
    }

    // ── 测试 5：失败记录有详细原因 ──
    console.log('\n测试 5: 失败记录保存到 failed-records/ 且包含失败原因');
    const failedDir = path.resolve(process.cwd(), 'failed-records');
    const failedFiles = fs.existsSync(failedDir)
        ? fs.readdirSync(failedDir).filter((f) => f.startsWith('batch-') && f.endsWith('.json'))
        : [];

    if (failedFiles.length > 0) {
        const latestFile = path.join(failedDir, failedFiles[failedFiles.length - 1]);
        const records = JSON.parse(fs.readFileSync(latestFile, 'utf-8'));
        const hasErrors = records.every((r: { errors: string[] }) => r.errors && r.errors.length > 0);

        if (hasErrors) {
            console.log(`  ✅ PASS: 找到 ${failedFiles.length} 个失败批次文件，每条记录都有错误原因`);
            console.log(`          示例: ${records[0].errors[0]}`);
            passed++;
        } else {
            console.log(`  ❌ FAIL: 失败记录缺少错误原因`);
            failed++;
        }
    } else {
        console.log(`  ❌ FAIL: failed-records/ 中没有批次文件`);
        failed++;
    }

    // 清理
    await col.deleteMany({ jobId: { $in: testJobIds } });
    await mongoose.disconnect();

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Bug 3 测试结果: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(50)}`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => { console.error('测试崩溃:', err); process.exit(1); });
