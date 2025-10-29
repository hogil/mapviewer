// 🚀 렌더링 최적화 모듈
class RenderOptimizer {
    constructor() {
        this.pendingTasks = [];
        this.isScheduled = false;
        this.renderQueue = [];
        this.highPriorityQueue = [];
    }

    // RequestIdleCallback을 사용한 낮은 우선순위 렌더링
    scheduleIdleTask(callback, priority = 'low') {
        if (priority === 'high') {
            this.highPriorityQueue.push(callback);
            this.processHighPriority();
        } else {
            this.pendingTasks.push(callback);
            this.scheduleIdleCallback();
        }
    }

    scheduleIdleCallback() {
        if (this.isScheduled) return;
        
        this.isScheduled = true;
        
        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback((deadline) => {
                this.processTasks(deadline);
            }, { timeout: 2000 }); // 최대 2초 대기
        } else {
            // Fallback: setTimeout
            setTimeout(() => {
                this.processTasks({ timeRemaining: () => 16 });
            }, 0);
        }
    }

    processTasks(deadline) {
        this.isScheduled = false;
        
        while ((deadline.timeRemaining() > 0 || deadline.didTimeout) && this.pendingTasks.length > 0) {
            const task = this.pendingTasks.shift();
            try {
                task();
            } catch (error) {
                console.error('[RenderOptimizer] Task failed:', error);
            }
        }
        
        // 남은 작업이 있으면 다시 스케줄링
        if (this.pendingTasks.length > 0) {
            this.scheduleIdleCallback();
        }
    }

    processHighPriority() {
        if (this.highPriorityQueue.length === 0) return;
        
        requestAnimationFrame(() => {
            const startTime = performance.now();
            const MAX_TIME = 16; // 1프레임 (60fps 기준)
            
            while (this.highPriorityQueue.length > 0 && (performance.now() - startTime) < MAX_TIME) {
                const task = this.highPriorityQueue.shift();
                try {
                    task();
                } catch (error) {
                    console.error('[RenderOptimizer] High priority task failed:', error);
                }
            }
            
            // 남은 작업이 있으면 다시 스케줄링
            if (this.highPriorityQueue.length > 0) {
                this.processHighPriority();
            }
        });
    }

    // Intersection Observer를 사용한 Lazy Loading
    createLazyLoader(elements, callback, options = {}) {
        const defaultOptions = {
            root: null,
            rootMargin: '50px', // 50px 전에 미리 로드
            threshold: 0.01
        };
        
        const observerOptions = { ...defaultOptions, ...options };
        
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    callback(entry.target);
                    observer.unobserve(entry.target);
                }
            });
        }, observerOptions);
        
        elements.forEach(element => observer.observe(element));
        
        return observer;
    }

    // Virtual Scrolling 헬퍼
    createVirtualScroller(container, items, renderItem, itemHeight) {
        const containerHeight = container.clientHeight;
        const visibleCount = Math.ceil(containerHeight / itemHeight) + 2; // 버퍼 추가
        let scrollTop = 0;
        
        const update = () => {
            const startIndex = Math.floor(scrollTop / itemHeight);
            const endIndex = Math.min(startIndex + visibleCount, items.length);
            
            // 가시 영역의 아이템만 렌더링
            const fragment = document.createDocumentFragment();
            for (let i = startIndex; i < endIndex; i++) {
                const element = renderItem(items[i], i);
                element.style.position = 'absolute';
                element.style.top = `${i * itemHeight}px`;
                fragment.appendChild(element);
            }
            
            // 이전 내용 제거 및 새 내용 추가
            container.innerHTML = '';
            container.appendChild(fragment);
            
            // 전체 높이 설정
            container.style.height = `${items.length * itemHeight}px`;
            container.style.position = 'relative';
        };
        
        container.addEventListener('scroll', () => {
            scrollTop = container.scrollTop;
            this.scheduleIdleTask(update, 'high');
        });
        
        update();
        return update;
    }

    // DOM 조작 배치 처리
    batchDOMUpdate(updates) {
        requestAnimationFrame(() => {
            updates.forEach(update => {
                try {
                    update();
                } catch (error) {
                    console.error('[RenderOptimizer] DOM update failed:', error);
                }
            });
        });
    }

    // CSS 애니메이션 최적화 (GPU 가속)
    optimizeAnimation(element) {
        element.style.willChange = 'transform, opacity';
        element.style.transform = 'translateZ(0)'; // GPU 가속 강제
        
        // 애니메이션 완료 후 will-change 제거
        element.addEventListener('transitionend', function cleanup() {
            element.style.willChange = 'auto';
            element.removeEventListener('transitionend', cleanup);
        });
    }

    // 이미지 로딩 최적화
    optimizeImageLoading(img, src, placeholder = null) {
        // 1. Placeholder 표시
        if (placeholder) {
            img.style.backgroundImage = `url(${placeholder})`;
            img.style.backgroundSize = 'cover';
        }
        
        // 2. 로딩 상태 표시
        img.style.opacity = '0';
        img.style.transition = 'opacity 0.3s ease-in-out';
        
        // 3. 이미지 사전 로딩
        const preloader = new Image();
        preloader.onload = () => {
            this.scheduleIdleTask(() => {
                img.src = src;
                img.style.opacity = '1';
                if (placeholder) {
                    img.style.backgroundImage = 'none';
                }
            }, 'high');
        };
        preloader.onerror = () => {
            console.error(`[RenderOptimizer] Image load failed: ${src}`);
            img.style.opacity = '1';
        };
        preloader.src = src;
    }

    // 메모리 사용량 모니터링
    checkMemoryUsage() {
        if (performance.memory) {
            const { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit } = performance.memory;
            const usagePercent = (usedJSHeapSize / jsHeapSizeLimit) * 100;
            
            if (usagePercent > 90) {
                console.warn(`[RenderOptimizer] High memory usage: ${usagePercent.toFixed(1)}%`);
                return { critical: true, usage: usagePercent };
            }
            
            return { critical: false, usage: usagePercent };
        }
        return { critical: false, usage: 0 };
    }

    // 성능 측정
    measurePerformance(name, callback) {
        const startTime = performance.now();
        const startMark = `${name}-start`;
        const endMark = `${name}-end`;
        
        performance.mark(startMark);
        
        try {
            const result = callback();
            
            if (result instanceof Promise) {
                return result.finally(() => {
                    performance.mark(endMark);
                    performance.measure(name, startMark, endMark);
                    const measure = performance.getEntriesByName(name)[0];
                    console.log(`[RenderOptimizer] ${name}: ${measure.duration.toFixed(2)}ms`);
                });
            } else {
                performance.mark(endMark);
                performance.measure(name, startMark, endMark);
                const measure = performance.getEntriesByName(name)[0];
                console.log(`[RenderOptimizer] ${name}: ${measure.duration.toFixed(2)}ms`);
                return result;
            }
        } catch (error) {
            console.error(`[RenderOptimizer] ${name} failed:`, error);
            throw error;
        }
    }
}

// 싱글톤 인스턴스
export const renderOptimizer = new RenderOptimizer();

// 편의 함수들
export function scheduleIdleTask(callback, priority = 'low') {
    renderOptimizer.scheduleIdleTask(callback, priority);
}

export function createLazyLoader(elements, callback, options) {
    return renderOptimizer.createLazyLoader(elements, callback, options);
}

export function batchDOMUpdate(updates) {
    renderOptimizer.batchDOMUpdate(updates);
}

export function measurePerformance(name, callback) {
    return renderOptimizer.measurePerformance(name, callback);
}

