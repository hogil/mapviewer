/**
 * PageManager
 * 엑셀 스타일 페이지/탭을 관리하는 가벼운 헬퍼.
 * - 역할별(prefix)로 이름을 0부터 증가
 * - 빈 페이지 추가/닫기/전환
 * - PageUp/PageDown 키 및 클릭으로 이동
 */
export class PageManager {
    constructor(options = {}) {
        this.tabListEl = options.tabListEl || null;
        this.addBtn = options.addBtn || null;
        this.onRequestState = options.onRequestState || null;
        this.onBeforePagePersist = options.onBeforePagePersist || null;
        this.onPageActivated = options.onPageActivated || null;
        this.onPageCreated = options.onPageCreated || null;
        this.onPageClosed = options.onPageClosed || null;
        this.shouldSkipShortcut = options.shouldSkipShortcut || null;

        this.pages = [];
        this.activePageId = null;
        this.nextId = 0;
        this.counters = { blank: 0, wafer: 0, label: 0, mylot: 0, composite: 0, measure: 0 };

        this.handleTabClick = this.handleTabClick.bind(this);
        this.handleAddClick = this.handleAddClick.bind(this);
        this.handleKeyDown = this.handleKeyDown.bind(this);

        this.bindUi();
    }

    bindUi() {
        if (this.tabListEl) {
            this.tabListEl.addEventListener('click', this.handleTabClick);
        }
        if (this.addBtn) {
            this.addBtn.addEventListener('click', this.handleAddClick);
        }
        document.addEventListener('keydown', this.handleKeyDown);
    }

    handleAddClick() {
        this.createPage('blank');
    }

    handleKeyDown(event) {
        if (event.key !== 'PageUp' && event.key !== 'PageDown') return;
        if (typeof this.shouldSkipShortcut === 'function' && this.shouldSkipShortcut(event)) {
            return;
        }
        if (!this.pages.length) return;
        event.preventDefault();
        const delta = event.key === 'PageUp' ? -1 : 1;
        this.activateRelative(delta);
    }

    handleTabClick(event) {
        const closeButton = event.target.closest('[data-close-id]');
        if (closeButton) {
            const id = closeButton.dataset.closeId;
            this.closePage(id);
            event.stopPropagation();
            return;
        }
        const tab = event.target.closest('[data-page-id]');
        if (!tab) return;
        const pageId = tab.dataset.pageId;
        if (pageId === this.activePageId) return;
        this.activatePage(pageId);
    }

    clone(value) {
        if (value === null || value === undefined) return value;
        if (typeof structuredClone === 'function') {
            try {
                return structuredClone(value);
            } catch (err) {
                // fallback
            }
        }
        try {
            return JSON.parse(JSON.stringify(value));
        } catch (err) {
            return value;
        }
    }

    buildTitle(role) {
        // 🔥 role에서 숫자 제거 (예: "composite1" → "composite")
        const baseRole = (role || 'blank').replace(/\d+$/, '');

        const prefix = {
            wafer: 'wafer',
            label: 'label',
            mylot: 'mylot',
            composite: 'com',
            measure: 'mea',
            blank: 'page',
        };
        const key = prefix[baseRole] ? baseRole : 'blank';
        const idx = this.counters[key] ?? 0;
        this.counters[key] = idx + 1;
        return `${prefix[key]}${idx}`;
    }

    createPage(role = 'blank', state = null, options = {}) {
        const page = {
            id: `page-${this.nextId++}`,
            role: role || 'blank',
            title: this.buildTitle(role || 'blank'),
            state: state ? this.clone(state) : null,
        };
        
        // 🔥 insertAfter 옵션이 있으면 특정 페이지 다음에 삽입
        if (options.insertAfter) {
            const insertIndex = this.pages.findIndex(p => p.id === options.insertAfter);
            if (insertIndex !== -1) {
                this.pages.splice(insertIndex + 1, 0, page);
            } else {
                // 찾지 못하면 맨 끝에 추가
                this.pages.push(page);
            }
        } else {
            this.pages.push(page);
        }
        
        if (typeof this.onPageCreated === 'function') {
            this.onPageCreated(page);
        }
        this.renderTabs();
        if (options.activate !== false) {
            this.activatePage(page.id, { skipPersist: options.skipPersist });
        }
        return page;
    }

    convertPage(id, role, state = null) {
        const page = this.pages.find(p => p.id === id);
        if (!page) return null;
        page.role = role || 'blank';
        page.title = this.buildTitle(role || 'blank');
        if (state !== null && state !== undefined) {
            page.state = this.clone(state);
        }
        this.renderTabs();
        if (this.activePageId === id && typeof this.onPageActivated === 'function') {
            const maybePromise = this.onPageActivated(page);
            if (maybePromise?.catch) {
                maybePromise.catch(err => console.error('[PageManager] activate error', err));
            }
        }
        return page;
    }

    persistActivePage(stateOverride) {
        if (!this.activePageId) return;
        const page = this.pages.find(p => p.id === this.activePageId);
        if (!page) return;
        const snapshot = stateOverride !== undefined
            ? stateOverride
            : (typeof this.onRequestState === 'function' ? this.onRequestState(page) : null);
        if (snapshot !== undefined) {
            page.state = this.clone(snapshot);
        }
    }

    activatePage(id, options = {}) {
        if (id === this.activePageId) return;
        if (!options.skipPersist) {
            this.persistActivePage();
            if (typeof this.onBeforePagePersist === 'function') {
                try {
                    this.onBeforePagePersist(this.getActivePage());
                } catch (err) {
                    console.error('[PageManager] onBeforePagePersist error', err);
                }
            }
        }
        this.activePageId = id;
        this.renderTabs();
        // skipApply: 페이지 상태 적용 건너뜀 (exitSingleImageViewMode에서 직접 복원할 때)
        if (options.skipApply) return;
        const page = this.pages.find(p => p.id === id);
        if (page && typeof this.onPageActivated === 'function') {
            const maybePromise = this.onPageActivated(page);
            if (maybePromise?.catch) {
                maybePromise.catch(err => console.error('[PageManager] activate error', err));
            }
        }
    }

    activateRelative(delta) {
        if (!this.pages.length || !delta) return;
        const currentIndex = this.pages.findIndex(p => p.id === this.activePageId);
        const safeIndex = currentIndex === -1 ? 0 : currentIndex;
        let nextIndex = safeIndex + delta;
        if (nextIndex < 0) nextIndex = this.pages.length - 1;
        if (nextIndex >= this.pages.length) nextIndex = 0;
        const nextPage = this.pages[nextIndex];
        if (nextPage) {
            this.activatePage(nextPage.id);
        }
    }

    ensurePageForRole(role, options = {}) {
        const active = this.pages.find(p => p.id === this.activePageId);
        if (active) {
            if (active.role === 'blank') {
                return this.convertPage(active.id, role, options.state);
            }
            if (active.role === role && !options.forceNew) {
                return active;
            }
        }
        if (!options.forceNew) {
            for (let i = this.pages.length - 1; i >= 0; i -= 1) {
                const page = this.pages[i];
                if (page.role === role) {
                    this.activatePage(page.id, { skipPersist: options.skipPersist });
                    return page;
                }
            }
        }
        return this.createPage(role, options.state, { activate: options.activate !== false });
    }

    closePage(id) {
        const idx = this.pages.findIndex(p => p.id === id);
        if (idx === -1) return;
        const closedPage = this.pages[idx];
        const wasActive = this.activePageId === id;
        this.pages.splice(idx, 1);
        if (typeof this.onPageClosed === 'function') {
            try {
                this.onPageClosed(closedPage);
            } catch (err) {
                console.error('[PageManager] onPageClosed error', err);
            }
        }
        if (!this.pages.length) {
            this.createPage('blank', null, { activate: true, skipPersist: true });
            return;
        }
        if (wasActive) {
            const fallback = this.pages[Math.max(0, idx - 1)] || this.pages[0];
            this.activatePage(fallback.id, { skipPersist: true });
        } else {
            this.renderTabs();
        }
    }

    getActivePage() {
        return this.pages.find(p => p.id === this.activePageId) || null;
    }

    renderTabs() {
        if (!this.tabListEl) return;
        this.tabListEl.innerHTML = '';
        this.pages.forEach(page => {
            const tab = document.createElement('button');
            tab.className = 'page-tab';
            tab.dataset.pageId = page.id;
            tab.title = page.title;
            tab.type = 'button';
            tab.setAttribute('data-role', page.role);
            if (page.id === this.activePageId) {
                tab.classList.add('active');
            }
            // 텍스트를 span으로 감싸서 가운데 정렬
            const textSpan = document.createElement('span');
            textSpan.className = 'page-tab-text';
            textSpan.textContent = page.title;
            tab.appendChild(textSpan);
            const close = document.createElement('span');
            close.className = 'page-tab-close';
            close.dataset.closeId = page.id;
            close.textContent = 'x';
            tab.appendChild(close);
            this.tabListEl.appendChild(tab);
        });
    }
}
