/**
 * Facade Service - 包装第三方 Audience API 调用
 * 
 * 使用 Playwright browser context 调用第三方 Audience API。
 * 支持两种 API 响应格式：新格式 (data.audience) 和老格式 (audience_data.demographics)。
 */

import { chromium, Browser, BrowserContext } from 'playwright';
import { MockAuthPool } from './mock-auth-pool';

/** New API response format: { status, data: { audience: { gender, age, geography } } } */
interface NewFormatResponse {
    status: string;
    data: {
        audience: {
            gender?: Array<{ label: string; value: number }>;
            age?: Array<{ label: string; value: number }>;
            geography?: {
                countries?: Array<{ name: string; code: string; percentage: number }>;
            };
        };
        meta?: {
            media_id: string;
            platform: string;
            last_updated: string;
        };
    };
}

/** Legacy API response format: { status, audience_data: { demographics: { gender, ... } } } */
interface LegacyFormatResponse {
    status: string;
    audience_data: {
        demographics: {
            gender?: Array<{ label: string; value: number }>;
            age?: Array<{ label: string; value: number }>;
            geography?: {
                countries?: Array<{ name: string; code: string; percentage: number }>;
            };
        };
    };
}

/** Normalized audience data returned by the facade */
interface NormalizedAudienceData {
    gender?: Array<{ label: string; value: number }>;
    age?: Array<{ label: string; value: number }>;
    geography?: any;
}

export type AudienceApiResponse = NewFormatResponse | LegacyFormatResponse;

export function isNewFormat(response: AudienceApiResponse): response is NewFormatResponse {
    return 'data' in response && response.data != null && 'audience' in response.data;
}

export function isLegacyFormat(response: AudienceApiResponse): response is LegacyFormatResponse {
    return 'audience_data' in response && response.audience_data != null;
}

/**
 * Extract audience data from either API response format into a normalized shape.
 */
export function extractAudienceData(response: AudienceApiResponse): NormalizedAudienceData | null {
    if (isNewFormat(response)) {
        console.log('[FacadeService] Detected new API response format');
        return response.data.audience;
    }

    if (isLegacyFormat(response)) {
        console.log('[FacadeService] Detected legacy API response format, normalizing...');
        const demographics = response.audience_data.demographics;
        return {
            gender: demographics.gender,
            age: demographics.age,
            geography: demographics.geography,
        };
    }

    return null;
}

export class FacadeAudienceService {
    private authPool: MockAuthPool;
    private sharedBrowser: Browser | null = null;

    constructor() {
        this.authPool = new MockAuthPool();
    }

    async getAudienceV1ByPlaywright(
        mediaType: 'instagram' | 'tiktok',
        mediaId: string,
        context?: BrowserContext,
    ): Promise<NormalizedAudienceData | null> {
        const url = `http://localhost:3001/api/v1/audience?media_type=${mediaType}&media_id=${mediaId}`;

        let browser: Browser | null = null;
        let shouldCloseBrowser = false;

        try {
            const auth = await this.authPool.getNextAuth();
            const token = await this.authPool.getToken(auth);

            console.log(`[FacadeService] Fetching audience for ${mediaType}:${mediaId}`);
            console.log(`[FacadeService] Using auth: ${auth.username}`);

            if (!context) {
                browser = await chromium.launch({ headless: true });
                context = await browser.newContext();
                shouldCloseBrowser = true;
            }

            const response = await context.request.get(url, {
                headers: {
                    'authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
            });

            const audienceData = await response.json();

            if (audienceData.status !== 'success') {
                console.error(`[FacadeService] API returned non-success status: ${audienceData.status}`);
                return null;
            }

            console.log('[FacadeService] Raw response:', JSON.stringify(audienceData).substring(0, 300));

            const extracted = extractAudienceData(audienceData as AudienceApiResponse);

            if (!extracted) {
                console.error('[FacadeService] Could not extract audience data from response');
                console.error('[FacadeService] Available keys:', Object.keys(audienceData));
                return null;
            }

            console.log(`[FacadeService] Successfully extracted audience data for ${mediaType}:${mediaId}`);
            return extracted;

        } catch (error) {
            console.error(`[FacadeService] Failed to fetch audience for ${mediaType}:${mediaId}:`, (error as Error).message);
            throw error;
        } finally {
            if (shouldCloseBrowser && browser) {
                await browser.close();
            }
        }
    }

    async batchGetAudience(requests: Array<{ mediaType: 'instagram' | 'tiktok'; mediaId: string }>) {
        console.log(`[FacadeService] Batch fetching ${requests.length} audience datasets`);

        let browser: Browser | null = null;
        let context: BrowserContext | null = null;

        try {
            browser = await chromium.launch({ headless: true });
            context = await browser.newContext();

            const results = await Promise.all(
                requests.map(req =>
                    this.getAudienceV1ByPlaywright(req.mediaType, req.mediaId, context!)
                )
            );

            const successCount = results.filter(r => r !== null).length;
            console.log(`[FacadeService] Batch complete: ${successCount}/${requests.length} succeeded`);

            return results;
        } finally {
            if (browser) {
                await browser.close();
            }
        }
    }

    async cleanup() {
        if (this.sharedBrowser) {
            await this.sharedBrowser.close();
            this.sharedBrowser = null;
        }
    }
}
