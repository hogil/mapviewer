// Seen (badge) and read (row highlight) are intentionally separate states.
export class AnnouncementCenter {
    constructor(viewer) {
        this.viewer = viewer;
        this.trigger = document.getElementById('announcements-button');
        this.badge = document.getElementById('announcements-count');
        this.dialog = document.getElementById('announcements-dialog');
        this.body = document.getElementById('announcements-body');
        this.items = [];
        this.busy = false;
        this.trigger.addEventListener('click', () => this.open());
        document.getElementById('announcements-close').addEventListener('click', () => this.dialog.close());
        this.dialog.addEventListener('keydown', event => event.stopPropagation());
        this.dialog.addEventListener('click', event => {
            if (event.target !== this.dialog) return;
            const box = this.dialog.getBoundingClientRect();
            if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) this.dialog.close();
        });
    }

    async request(action, ids) {
        const options = { cache: 'no-store' };
        if (action) Object.assign(options, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ids }) });
        const loginId = this.viewer.announcementLoginId;
        const url = loginId ? `/api/announcements?LoginId=${encodeURIComponent(loginId)}` : this.viewer._withCurrentLoginId('/api/announcements');
        const response = await fetch(url, options);
        if (!response.ok) throw new Error('공지를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
        const data = await response.json();
        this.items = data.items;
        this.badge.textContent = data.new_count > 99 ? '99+' : String(data.new_count);
        this.badge.hidden = data.new_count === 0;
        this.trigger.setAttribute('aria-label', data.new_count ? `공지, 새 공지 ${data.new_count}개` : '공지');
        return data;
    }

    element(tag, className, text) {
        const node = document.createElement(tag);
        node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    meta(item) {
        const meta = this.element('div', 'announcement-meta');
        meta.append(this.element('span', '', item.category));
        const date = this.element('time', '', item.date);
        date.dateTime = item.date;
        meta.append(date);
        return meta;
    }

    renderList() {
        this.body.replaceChildren();
        if (!this.items.length) {
            this.body.append(this.element('p', 'announcement-message', '등록된 공지가 없습니다.'));
            return;
        }
        for (const item of this.items) {
            const row = this.element('button', `announcement-row${item.read ? '' : ' unread'}`);
            row.type = 'button';
            row.dataset.noticeId = item.id;
            const meta = this.meta(item);
            if (!item.read) meta.append(this.element('span', 'announcement-unread', '안 읽음'));
            row.append(meta, this.element('h3', '', item.title), this.element('p', '', item.summary));
            row.addEventListener('click', () => this.openDetail(item.id));
            this.body.append(row);
        }
    }

    showError(error) {
        this.body.replaceChildren(this.element('p', 'announcement-message', error.message));
        const retry = this.element('button', 'announcement-back', '다시 불러오기');
        retry.type = 'button';
        retry.addEventListener('click', () => this.open());
        this.body.append(retry);
    }

    async open() {
        if (this.busy) return;
        this.busy = true;
        if (!this.dialog.open) this.dialog.showModal();
        this.body.replaceChildren(this.element('p', 'announcement-message', '공지를 불러오는 중입니다.'));
        try {
            const data = await this.request();
            await this.request('seen', data.items.map(item => item.id));
            this.renderList();
        } catch (error) {
            this.showError(error);
        } finally {
            this.busy = false;
        }
    }

    async openDetail(id) {
        if (this.busy) return;
        this.busy = true;
        try {
            await this.request('read', [id]);
            const item = this.items.find(notice => notice.id === id);
            const back = this.element('button', 'announcement-back', '← 공지 목록');
            back.type = 'button';
            back.addEventListener('click', () => {
                this.renderList();
                this.body.querySelector(`[data-notice-id="${CSS.escape(id)}"]`)?.focus();
            });
            const article = this.element('article', 'announcement-article');
            article.append(this.meta(item), this.element('h3', '', item.title));
            for (const paragraph of item.paragraphs) article.append(this.element('p', '', paragraph));
            this.body.replaceChildren(back, article);
            back.focus();
        } catch (error) {
            this.showError(error);
        } finally {
            this.busy = false;
        }
    }
}

export function initializeAnnouncements(viewer) {
    if (viewer.announcementCenter) return;
    viewer.announcementCenter = new AnnouncementCenter(viewer);
    void viewer.announcementCenter.request().catch(() => {
        viewer.announcementCenter.trigger.title = '공지 불러오기 실패 · 클릭하여 다시 시도';
    });
}
