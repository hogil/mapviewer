// 🚀 IndexedDB 캐싱 Web Worker
const DB_NAME = 'WaferMapCache';
const DB_VERSION = 1;
const STORE_NAME = 'responses';
const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100MB
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24시간

let db = null;

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
        
        // 캐시 크기 체크 및 정리
        await cleanupCache();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put({
                url,
                data,
                timestamp: Date.now()
            });
            
            request.onsuccess = () => resolve(true);
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
                    totalSize += JSON.stringify(entry.data).length;
                    entries.push({ url: entry.url, timestamp: entry.timestamp });
                    cursor.continue();
                } else {
                    // 크기가 MAX_CACHE_SIZE를 초과하면 오래된 것부터 삭제
                    if (totalSize > MAX_CACHE_SIZE) {
                        entries.sort((a, b) => a.timestamp - b.timestamp);
                        const deleteCount = Math.ceil(entries.length * 0.2); // 20% 삭제
                        
                        for (let i = 0; i < deleteCount; i++) {
                            store.delete(entries[i].url);
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

// 전체 캐시 초기화
async function clearCache() {
    try {
        await initDB();
        
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.clear();
            
            request.onsuccess = () => resolve(true);
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

