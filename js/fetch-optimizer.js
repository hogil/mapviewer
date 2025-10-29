// 🚀 Fetch 최적화 모듈
class FetchOptimizer {
    constructor() {
        this.cacheWorker = null;
        this.pendingRequests = new Map();
        this.requestId = 0;
        this.initWorker();
    }

    initWorker() {
        try {
            this.cacheWorker = new Worker('/js/cache-worker.js');
            this.cacheWorker.onmessage = (event) => {
                const { id, success, data, error } = event.data;
                const pending = this.pendingRequests.get(id);
                if (pending) {
                    if (success) {
                        pending.resolve(data);
                    } else {
                        pending.reject(new Error(error || 'Cache worker failed'));
                    }
                    this.pendingRequests.delete(id);
                }
            };
            
            this.cacheWorker.onerror = (error) => {
                console.error('[FetchOptimizer] Worker error:', error);
                this.cacheWorker = null;
            };
        } catch (error) {
            console.warn('[FetchOptimizer] Worker initialization failed:', error);
            this.cacheWorker = null;
        }
    }

    async workerRequest(action, url, data) {
        if (!this.cacheWorker) {
            return null;
        }

        const id = ++this.requestId;
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.cacheWorker.postMessage({ id, action, url, data });
            
            // 타임아웃 설정 (5초)
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error('Cache worker timeout'));
                }
            }, 5000);
        });
    }

    async fetchWithCache(url, options = {}) {
        const cacheKey = url + (options.method || 'GET');
        
        // 🚀 1. 캐시 확인
        try {
            const cached = await this.workerRequest('get', cacheKey);
            if (cached) {
                console.log(`[FetchOptimizer] Cache hit: ${url}`);
                return cached;
            }
        } catch (error) {
            console.warn('[FetchOptimizer] Cache get failed:', error);
        }

        // 🚀 2. 네트워크 요청
        const fetchOptions = {
            ...options,
            headers: {
                ...options.headers,
                'Accept-Encoding': 'br, gzip, deflate', // Brotli 우선
            }
        };

        try {
            const response = await fetch(url, fetchOptions);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();

            // 🚀 3. 캐시 저장 (비동기로 처리, 결과를 기다리지 않음)
            this.workerRequest('set', cacheKey, data).catch(err => {
                console.warn('[FetchOptimizer] Cache set failed:', err);
            });

            return data;
        } catch (error) {
            console.error(`[FetchOptimizer] Fetch failed: ${url}`, error);
            throw error;
        }
    }

    async clearCache() {
        try {
            await this.workerRequest('clear');
            console.log('[FetchOptimizer] Cache cleared');
        } catch (error) {
            console.error('[FetchOptimizer] Clear cache failed:', error);
        }
    }
}

// 싱글톤 인스턴스
export const fetchOptimizer = new FetchOptimizer();

// 기본 fetch 래퍼
export async function optimizedFetch(url, options = {}) {
    // GET 요청만 캐싱 (POST/PUT/DELETE는 캐싱하지 않음)
    if (!options.method || options.method === 'GET') {
        return fetchOptimizer.fetchWithCache(url, options);
    }
    
    // POST/PUT/DELETE는 일반 fetch 사용
    return fetch(url, options).then(r => r.json());
}

