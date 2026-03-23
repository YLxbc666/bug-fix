import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

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

type ValidRecord = z.infer<typeof ChaosRecordSchema>;

interface FailedRecord {
    record: unknown;
    errors: string[];
}

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

async function main(): Promise<void> {
    const inputPath = path.resolve(process.cwd(), 'debug-payloads/chaos-data-samples.json');
    if (!fs.existsSync(inputPath)) {
        console.error(`File not found: ${inputPath}`);
        process.exit(1);
    }

    const rawData: unknown[] = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    console.log(`[ChaosProcessor] Loaded ${rawData.length} records from ${inputPath}\n`);

    const processed: ValidRecord[] = [];
    const failed: FailedRecord[] = [];

    for (const raw of rawData) {
        const normalized = normalizeRecord(raw as Record<string, unknown>);
        const result = ChaosRecordSchema.safeParse(normalized);

        if (result.success) {
            processed.push(result.data);
        } else {
            const errors = result.error.issues.map(
                (issue) => `${issue.path.join('.')}: ${issue.message}`,
            );
            const id = (raw as Record<string, unknown>).id ?? 'unknown';
            console.log(`  SKIP ${id}: ${errors.join('; ')}`);
            failed.push({ record: raw, errors });
        }
    }

    console.log('');
    console.log(`Processed: ${processed.length} records`);
    console.log(`Skipped (validation failed): ${failed.length} records`);

    if (failed.length > 0) {
        const failedDir = path.resolve(process.cwd(), 'failed-records');
        if (!fs.existsSync(failedDir)) {
            fs.mkdirSync(failedDir, { recursive: true });
        }
        const outFile = path.join(failedDir, `batch-${Date.now()}.json`);
        fs.writeFileSync(outFile, JSON.stringify(failed, null, 2));
        console.log(`Failed records saved to: ${outFile}`);
    }
}

main().catch((error) => {
    console.error('[ChaosProcessor] Fatal error:', error);
    process.exit(1);
});
