/**
 * Part 4 测试：Audience 数据格式兼容性 Bug
 *
 * 验证 facade-audience.service.ts 修复后能正确处理两种 API 响应格式：
 *   - 新格式: { status, data: { audience: { gender, age, geography } } }
 *   - 老格式: { status, audience_data: { demographics: { gender, ... } } }
 *
 * 测试分为两部分：
 *   Part A: 纯逻辑单元测试（不依赖 Playwright / 网络）
 *   Part B: 端到端集成测试（启动 Mock API + Playwright）
 *
 * 运行方式:
 *   pnpm tsx scripts/test-part4-audience-bug.ts          # 仅运行 Part A（无需 Playwright）
 *   pnpm tsx scripts/test-part4-audience-bug.ts --e2e    # 运行 Part A + Part B
 */

import {
    extractAudienceData,
    isNewFormat,
    isLegacyFormat,
    type AudienceApiResponse,
} from '../apps/worker-service/src/audience-integration/facade-audience.service';

const runE2E = process.argv.includes('--e2e');

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
    if (condition) {
        console.log(`  ✅ PASS: ${label}`);
        passed++;
    } else {
        console.log(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

// ─── Part A: 单元测试 ────────────────────────────────────────

async function unitTests(): Promise<void> {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Part 4 测试 — Part A: 数据提取逻辑单元测试                    ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // ── 测试 1: 识别新格式 ──
    console.log('测试 1: 正确识别新格式响应');
    const newFormat: AudienceApiResponse = {
        status: 'success',
        data: {
            audience: {
                gender: [
                    { label: 'male', value: 0.42 },
                    { label: 'female', value: 0.58 },
                ],
                age: [
                    { label: '18-24', value: 0.35 },
                    { label: '25-34', value: 0.45 },
                ],
                geography: {
                    countries: [{ name: 'US', code: 'US', percentage: 60 }],
                },
            },
        },
    } as AudienceApiResponse;

    assert(isNewFormat(newFormat), '新格式被 isNewFormat 识别');
    assert(!isLegacyFormat(newFormat), '新格式不被 isLegacyFormat 识别');

    // ── 测试 2: 识别老格式 ──
    console.log('\n测试 2: 正确识别老 (legacy) 格式响应');
    const legacyFormat: AudienceApiResponse = {
        status: 'success',
        audience_data: {
            demographics: {
                gender: [
                    { label: 'male', value: 0.45 },
                    { label: 'female', value: 0.55 },
                ],
            },
        },
    } as AudienceApiResponse;

    assert(!isNewFormat(legacyFormat), '老格式不被 isNewFormat 识别');
    assert(isLegacyFormat(legacyFormat), '老格式被 isLegacyFormat 识别');

    // ── 测试 3: 提取新格式数据 ──
    console.log('\n测试 3: 从新格式中正确提取受众数据');
    const newExtracted = extractAudienceData(newFormat);
    assert(newExtracted !== null, '新格式提取结果不为 null');
    assert(
        Array.isArray(newExtracted?.gender) && newExtracted!.gender!.length === 2,
        '新格式 gender 数组长度为 2',
    );
    assert(
        Array.isArray(newExtracted?.age) && newExtracted!.age!.length === 2,
        '新格式 age 数组长度为 2',
    );
    assert(newExtracted?.geography != null, '新格式 geography 不为空');

    // ── 测试 4: 提取老格式数据 ──
    console.log('\n测试 4: 从老格式中正确提取受众数据');
    const legacyExtracted = extractAudienceData(legacyFormat);
    assert(legacyExtracted !== null, '老格式提取结果不为 null');
    assert(
        Array.isArray(legacyExtracted?.gender) && legacyExtracted!.gender!.length === 2,
        '老格式 gender 数组长度为 2',
    );
    assert(
        legacyExtracted?.gender?.[0]?.value === 0.45,
        '老格式 gender[0].value = 0.45（区别于新格式的 0.42）',
    );

    // ── 测试 5: 完全未知格式返回 null ──
    console.log('\n测试 5: 完全未知格式应返回 null');
    const unknownFormat = { status: 'success', something_else: {} } as unknown as AudienceApiResponse;
    const unknownExtracted = extractAudienceData(unknownFormat);
    assert(unknownExtracted === null, '未知格式返回 null');

    // ── 测试 6: 老格式只有 gender 无 age/geography ──
    console.log('\n测试 6: 老格式部分字段缺失时正常提取');
    const partialLegacy: AudienceApiResponse = {
        status: 'success',
        audience_data: {
            demographics: {
                gender: [{ label: 'male', value: 0.5 }, { label: 'female', value: 0.5 }],
            },
        },
    } as AudienceApiResponse;
    const partialExtracted = extractAudienceData(partialLegacy);
    assert(partialExtracted !== null, '部分字段缺失时仍能提取');
    assert(partialExtracted?.age === undefined, 'age 为 undefined（未提供）');
    assert(partialExtracted?.geography === undefined, 'geography 为 undefined（未提供）');

    // ── 测试 7: 新格式含 meta 时正常提取 ──
    console.log('\n测试 7: 新格式含 meta 字段时数据提取不受影响');
    const withMeta: AudienceApiResponse = {
        status: 'success',
        data: {
            audience: {
                gender: [{ label: 'male', value: 0.4 }, { label: 'female', value: 0.6 }],
            },
            meta: {
                media_id: '67890',
                platform: 'instagram',
                last_updated: new Date().toISOString(),
            },
        },
    } as AudienceApiResponse;
    const metaExtracted = extractAudienceData(withMeta);
    assert(metaExtracted !== null, '含 meta 的新格式仍正确提取');
    assert(metaExtracted?.gender?.[0]?.value === 0.4, 'gender 数据正确');
}

// ─── Part B: 端到端集成测试 ────────────────────────────────────

async function e2eTests(): Promise<void> {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║  Part 4 测试 — Part B: 端到端集成测试 (Playwright + MockAPI) ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { startMockAudienceServer } = await import(
        '../apps/worker-service/src/audience-integration/mock-audience-api'
    );
    const { AudienceService } = await import(
        '../apps/worker-service/src/audience-integration/audience.service'
    );

    await startMockAudienceServer();
    console.log('✅ Mock API server started\n');

    const audienceService = new AudienceService();

    // ── 测试 8: 新格式 mediaId 正常返回 ──
    console.log('测试 8: 新格式 mediaId (67890) 返回非 null');
    const result1 = await audienceService.fetchAudienceData('instagram', '67890');
    assert(result1 !== null, 'instagram:67890 返回数据');
    assert(result1?.gender != null, '包含 gender');
    assert(result1?.age != null, '包含 age');

    // ── 测试 9: 老格式 mediaId=12345 现在也应成功 ──
    console.log('\n测试 9: 老格式 mediaId (12345) 修复后也返回非 null');
    const result2 = await audienceService.fetchAudienceData('instagram', '12345');
    assert(result2 !== null, 'instagram:12345 返回数据（修复前这里返回 null）');
    assert(result2?.gender != null, '包含 gender（来自 audience_data.demographics）');
    assert(
        result2?.gender?.[0]?.value === 0.45,
        'gender[0].value = 0.45（老格式特有数据）',
    );

    // ── 测试 10: 批量获取 0 errors ──
    console.log('\n测试 10: 批量获取所有 influencers，errors 应为 0');
    const batch = await audienceService.batchFetchAudienceData([
        { instagram_id: '67890', tiktok_id: '11111' },
        { instagram_id: '12345' },
        { instagram_id: '99999', tiktok_id: '22222' },
    ]);
    assert(batch.errors.length === 0, `Errors: ${batch.errors.length} (期望 0)`);
    assert(batch.results.length === 5, `Results: ${batch.results.length} (期望 5)`);

    await audienceService.cleanup();
}

// ─── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
    await unitTests();

    if (runE2E) {
        await e2eTests();
    } else {
        console.log('\n💡 跳过 Part B 端到端测试（使用 --e2e 参数启用）');
    }

    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Part 4 测试结果: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(50)}`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('测试崩溃:', err);
    process.exit(1);
});
