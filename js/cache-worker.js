// 🚀 IndexedDB 캐싱 Web Worker
const DB_NAME = 'WaferMapCache';
const DB_VERSION = 2;
const STORE_NAME = 'responses';
const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100MB
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간
const CLEANUP_MIN_INTERVAL_MS = 30 * 1000; // 30초
const CLEANUP_WRITE_THRESHOLD = 20; // write 20회마다 1회 정리 시도
const CLEANUP_TARGET_RATIO = 0.8; // 초과 시 80%까지 정리

let db = null;
let lastCleanupAt = 0;
let writesSinceCleanup = 0;
let cleanupInFlight = null;

function estimateDataSize(data) {
    if (data == null) return 0;
    if (typeof data === 'string') return data.length;
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return data.byteLength;
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
    try {
        return JSON.stringify(data).length;
    } catch (_) {
        return 0;
    }
}

// IndexedDB 초기화
async function initDB() {
    if (db) return db;
    
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'url' });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            } else {
                const tx = event.target.transaction;
                const store = tx.objectStore(STORE_NAME);
                if (!store.indexNames.contains('timestamp')) {
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }
            }
        };
    });
}

// 캐시에서 데이터 가져오기
async function getCache(url) {
    try {
        await initDB();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(url);
            
            request.onsuccess = () => {
                const cached = request.result;
                if (!cached) {
                    resolve(null);
                    return;
                }
                
                // TTL 체크
                if (Date.now() - cached.timestamp > CACHE_TTL) {
                    // 만료된 캐시 삭제
                    deleteCache(url);
                    resolve(null);
                } else {
                    resolve(cached.data);
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('[CacheWorker] getCache error:', error);
        return null;
    }
}

// 캐시에 데이터 저장
async function setCache(url, data) {
    try {
        await initDB();

        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put({
                url,
                data,
                timestamp: Date.now(),
                size: estimateDataSize(data),
            });
            
            request.onsuccess = () => {
                writesSinceCleanup += 1;
                maybeCleanupCache().catch((error) => {
                    console.error('[CacheWorker] maybeCleanupCache error:', error);
                });
                resolve(true);
            };
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('[CacheWorker] setCache error:', error);
        return false;
    }
}

// 캐시 삭제
async function deleteCache(url) {
    try {
        await initDB();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.delete(url);
            
            request.onsuccess = () => resolve(true);
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('[CacheWorker] deleteCache error:', error);
        return false;
    }
}

// 오래된 캐시 정리
async function cleanupCache() {
    try {
        await initDB();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const index = store.index('timestamp');
            const request = index.openCursor();
            
            let totalSize = 0;
            const entries = [];
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const entry = cursor.value;
                    const entrySize = typeof entry.size === 'number' ? entry.size : estimateDataSize(entry.data);
                    totalSize += entrySize;
                    entries.push({ url: entry.url, size: entrySize });
                    cursor.continue();
                } else {
                    // 크기가 MAX_CACHE_SIZE를 초과하면 오래된 것부터 삭제
                    if (totalSize > MAX_CACHE_SIZE) {
                        const targetSize = Math.floor(MAX_CACHE_SIZE * CLEANUP_TARGET_RATIO);
                        let removableBytes = totalSize - targetSize;
                        for (let i = 0; i < entries.length && removableBytes > 0; i++) {
                            const item = entries[i];
                            store.delete(item.url);
                            removableBytes -= item.size;
                        }
                    }
                    resolve(true);
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('[CacheWorker] cleanupCache error:', error);
        return false;
    }
}

async function maybeCleanupCache(force = false) {
    const now = Date.now();
    const dueByTime = now - lastCleanupAt >= CLEANUP_MIN_INTERVAL_MS;
    const dueByWrites = writesSinceCleanup >= CLEANUP_WRITE_THRESHOLD;

    if (!force && !dueByTime && !dueByWrites) {
        return true;
    }

    if (cleanupInFlight) {
        return cleanupInFlight;
    }

    cleanupInFlight = (async () => {
        try {
            await cleanupCache();
            lastCleanupAt = Date.now();
            writesSinceCleanup = 0;
            return true;
        } finally {
            cleanupInFlight = null;
        }
    })();

    return cleanupInFlight;
}

// 전체 캐시 초기화
async function clearCache() {
    try {
        await initDB();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.clear();
            
            request.onsuccess = () => {
                lastCleanupAt = Date.now();
                writesSinceCleanup = 0;
                resolve(true);
            };
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('[CacheWorker] clearCache error:', error);
        return false;
    }
}

// 메시지 핸들러
self.onmessage = async (event) => {
    const { id, action, url, data } = event.data || {};
    
    try {
        let result;
        
        switch (action) {
            case 'get':
                result = await getCache(url);
                self.postMessage({ id, success: true, data: result });
                break;
                
            case 'set':
                result = await setCache(url, data);
                self.postMessage({ id, success: result });
                break;
                
            case 'delete':
                result = await deleteCache(url);
                self.postMessage({ id, success: result });
                break;
                
            case 'clear':
                result = await clearCache();
                self.postMessage({ id, success: result });
                break;
                
            default:
                self.postMessage({ id, success: false, error: 'Unknown action' });
        }
    } catch (error) {
        self.postMessage({ id, success: false, error: error.message });
    }
};

