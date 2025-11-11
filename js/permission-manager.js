/**
 * Permission Manager - Role & Access Control UI
 */

export class PermissionManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.users = [];
        this.selectedUser = null;
        this.auditLogs = [];
        this.selectedUserSearchIndex = -1; // 키보드 네비게이션용
        this.createDialog = null; // 사용자 생성 다이얼로그
        this.boundKeyHandler = this.handleKeyDown.bind(this);
    }

    /**
     * 초기화
     */
    async init() {
        await this.loadUsers();
        this.renderUI();
        this.bindEvents();
    }

    /**
     * 사용자 목록 로드
     */
    async loadUsers() {
        try {
            const res = await fetch('/api/users');
            const data = await res.json();

            if (data.success) {
                this.users = data.users || [];
            } else {
                console.error('사용자 목록 로드 실패:', data);
            }
        } catch (error) {
            console.error('사용자 목록 로드 오류:', error);
        }
    }

    /**
     * UI 렌더링
     */
    renderUI() {
        const container = document.getElementById('permission-manager-container');
        if (!container) return;

        container.innerHTML = `
            <div class="permission-manager">
                <div class="permission-header">
                    <h2>Role & Access Control</h2>
                    <button id="pm-create-user-btn" class="btn-primary">+ 사용자 생성</button>
                </div>

                <div class="permission-content">
                    <!-- 사용자 목록 -->
                    <div class="permission-users">
                        <h3>사용자 목록</h3>
                        <div id="pm-user-list" class="user-list"></div>
                    </div>

                    <!-- 사용자 상세 정보 -->
                    <div class="permission-details">
                        <h3>사용자 정보</h3>
                        <div id="pm-user-details" class="user-details">
                            <p class="placeholder">사용자를 선택하세요</p>
                        </div>
                    </div>

                    <!-- 감사 로그 -->
                    <div class="permission-audit">
                        <h3>감사 로그</h3>
                        <button id="pm-load-audit-btn" class="btn-secondary">로그 조회</button>
                        <div id="pm-audit-logs" class="audit-logs"></div>
                    </div>
                </div>
            </div>
        `;

        this.renderUserList();
    }

    /**
     * 사용자 목록 렌더링
     */
    renderUserList() {
        const listContainer = document.getElementById('pm-user-list');
        if (!listContainer) return;

        if (this.users.length === 0) {
            listContainer.innerHTML = '<p class="empty">등록된 사용자가 없습니다.</p>';
            return;
        }

        listContainer.innerHTML = this.users.map(user => `
            <div class="user-item ${this.selectedUser?.username === user.username ? 'selected' : ''}"
                 data-username="${user.username}">
                <div class="user-info">
                    <div class="user-name">${user.display_name}</div>
                    <div class="user-email">${user.email}</div>
                </div>
                <div class="user-role-badge role-${user.role.toLowerCase()}">${user.role}</div>
            </div>
        `).join('');
    }

    /**
     * 사용자 상세 정보 렌더링
     */
    renderUserDetails(user) {
        const detailsContainer = document.getElementById('pm-user-details');
        if (!detailsContainer || !user) return;

        const grants = user.grants || [];

        detailsContainer.innerHTML = `
            <div class="user-detail-card">
                <div class="detail-row">
                    <label>사용자명:</label>
                    <span>${user.username}</span>
                </div>
                <div class="detail-row">
                    <label>표시 이름:</label>
                    <span>${user.display_name}</span>
                </div>
                <div class="detail-row">
                    <label>이메일:</label>
                    <span>${user.email}</span>
                </div>
                <div class="detail-row">
                    <label>역할:</label>
                    <select id="pm-role-select" class="role-select">
                        <option value="USER" ${user.role === 'USER' ? 'selected' : ''}>USER</option>
                        <option value="POWER" ${user.role === 'POWER' ? 'selected' : ''}>POWER</option>
                        <option value="ADMIN" ${user.role === 'ADMIN' ? 'selected' : ''}>ADMIN</option>
                        <option value="SUPER" ${user.role === 'SUPER' ? 'selected' : ''}>SUPER</option>
                    </select>
                    <button id="pm-update-role-btn" class="btn-small">변경</button>
                </div>
                <div class="detail-row">
                    <label>생성일:</label>
                    <span>${new Date(user.created_at).toLocaleString('ko-KR')}</span>
                </div>
                <div class="detail-row">
                    <label>수정일:</label>
                    <span>${new Date(user.updated_at).toLocaleString('ko-KR')}</span>
                </div>
            </div>

            <div class="grants-section">
                <h4>폴더 권한</h4>
                <button id="pm-add-grant-btn" class="btn-small">+ 권한 추가</button>
                <div id="pm-grants-list" class="grants-list">
                    ${grants.length === 0 ? '<p class="empty">부여된 폴더 권한이 없습니다.</p>' : ''}
                    ${grants.map(grant => `
                        <div class="grant-item">
                            <div class="grant-folder">${grant.folder}</div>
                            <div class="grant-level role-${grant.level.toLowerCase()}">${grant.level}</div>
                            <button class="btn-remove" data-folder="${grant.folder}">제거</button>
                        </div>
                    `).join('')}
                </div>
            </div>

            <div class="user-actions">
                <button id="pm-delete-user-btn" class="btn-danger">사용자 삭제</button>
            </div>
        `;
    }

    /**
     * 이벤트 바인딩
     */
    bindEvents() {
        // 사용자 생성 버튼
        document.getElementById('pm-create-user-btn')?.addEventListener('click', () => {
            this.showCreateUserDialog();
        });

        // 감사 로그 조회 버튼
        document.getElementById('pm-load-audit-btn')?.addEventListener('click', () => {
            this.loadAuditLogs();
        });

        // 사용자 목록 클릭
        document.getElementById('pm-user-list')?.addEventListener('click', (e) => {
            const userItem = e.target.closest('.user-item');
            if (userItem) {
                const username = userItem.dataset.username;
                this.selectUser(username);
            }
        });

        // 사용자 상세 정보 이벤트 위임
        document.getElementById('pm-user-details')?.addEventListener('click', async (e) => {
            // 역할 변경
            if (e.target.id === 'pm-update-role-btn') {
                await this.updateUserRole();
            }
            // 권한 추가
            else if (e.target.id === 'pm-add-grant-btn') {
                this.showAddGrantDialog();
            }
            // 권한 제거
            else if (e.target.classList.contains('btn-remove')) {
                const folder = e.target.dataset.folder;
                await this.removeGrant(folder);
            }
            // 사용자 삭제
            else if (e.target.id === 'pm-delete-user-btn') {
                await this.deleteUser();
            }
        });
    }

    /**
     * 사용자 선택
     */
    async selectUser(username) {
        try {
            const res = await fetch(`/api/users/${username}`);
            const data = await res.json();

            if (data.success) {
                this.selectedUser = data.user;
                this.renderUserList();
                this.renderUserDetails(this.selectedUser);
            }
        } catch (error) {
            console.error('사용자 정보 로드 오류:', error);
        }
    }

    /**
     * 사용자 생성 다이얼로그
     */
    showCreateUserDialog() {
        // 기존 다이얼로그가 있으면 제거
        if (this.createDialog) {
            this.createDialog.remove();
        }

        // 다이얼로그 HTML 생성
        const dialog = document.createElement('div');
        dialog.id = 'pm-create-user-dialog';
        dialog.className = 'pm-dialog-overlay';
        dialog.innerHTML = `
            <div class="pm-dialog">
                <div class="pm-dialog-header">
                    <h3>사용자 생성</h3>
                    <button id="pm-dialog-close" class="pm-dialog-close">×</button>
                </div>
                <div class="pm-dialog-body">
                    <!-- 사용자 검색 (stats.json) -->
                    <div class="pm-form-group">
                        <label>사용자 검색 (접속 이력)</label>
                        <div class="pm-search-container">
                            <input type="text" id="pm-user-search-input" class="pm-input"
                                   placeholder="Username 또는 LoginId 검색...">
                            <button id="pm-user-search-btn" class="btn-secondary">🔍</button>
                        </div>
                        <div id="pm-user-search-dropdown" class="pm-dropdown" aria-expanded="false"></div>
                    </div>

                    <!-- 사용자 정보 입력 -->
                    <div class="pm-form-group">
                        <label for="pm-new-username">사용자명 (LoginId) *</label>
                        <input type="text" id="pm-new-username" class="pm-input" placeholder="ex: 12345" required>
                    </div>

                    <div class="pm-form-group">
                        <label for="pm-new-displayname">표시 이름 (Username) *</label>
                        <input type="text" id="pm-new-displayname" class="pm-input" placeholder="ex: 홍길동" required>
                    </div>

                    <div class="pm-form-group">
                        <label for="pm-new-email">이메일</label>
                        <input type="email" id="pm-new-email" class="pm-input" placeholder="ex: user@company.com">
                    </div>

                    <div class="pm-form-group">
                        <label for="pm-new-role">역할 *</label>
                        <select id="pm-new-role" class="pm-select">
                            <option value="USER">USER (읽기 전용)</option>
                            <option value="POWER">POWER (라벨링 가능)</option>
                            <option value="ADMIN">ADMIN (클래스 관리 + 전체 폴더 권한)</option>
                            <option value="SUPER">SUPER (모든 권한)</option>
                        </select>
                    </div>

                    <div class="pm-form-group">
                        <label for="pm-new-folders">제품 폴더 권한</label>
                        <input type="text" id="pm-new-folders" class="pm-input"
                               placeholder="쉼표 구분: ABCD,FESD,YEGF 또는 * (전체)">
                        <small class="pm-hint">ADMIN/SUPER 역할은 자동으로 * (전체 권한)</small>
                    </div>

                    <div id="pm-dialog-error" class="pm-dialog-error"></div>
                </div>
                <div class="pm-dialog-footer">
                    <button id="pm-dialog-cancel" class="btn-secondary">취소</button>
                    <button id="pm-dialog-create" class="btn-primary">생성</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);
        this.createDialog = dialog;

        // 이벤트 바인딩
        this.bindCreateDialogEvents();

        // 키보드 이벤트 리스너 추가
        document.addEventListener('keydown', this.boundKeyHandler);

        // 첫 번째 입력 필드에 포커스
        setTimeout(() => {
            document.getElementById('pm-user-search-input')?.focus();
        }, 100);
    }

    /**
     * 생성 다이얼로그 닫기
     */
    closeCreateDialog() {
        if (this.createDialog) {
            this.createDialog.remove();
            this.createDialog = null;
        }
        this.selectedUserSearchIndex = -1;
        document.removeEventListener('keydown', this.boundKeyHandler);
    }

    /**
     * 생성 다이얼로그 이벤트 바인딩
     */
    bindCreateDialogEvents() {
        const dialog = this.createDialog;
        if (!dialog) return;

        // 닫기 버튼
        dialog.querySelector('#pm-dialog-close')?.addEventListener('click', () => {
            this.closeCreateDialog();
        });

        // 취소 버튼
        dialog.querySelector('#pm-dialog-cancel')?.addEventListener('click', () => {
            this.closeCreateDialog();
        });

        // 생성 버튼
        dialog.querySelector('#pm-dialog-create')?.addEventListener('click', () => {
            this.handleCreateUser();
        });

        // 검색 버튼
        dialog.querySelector('#pm-user-search-btn')?.addEventListener('click', () => {
            this.searchUsers(true);
        });

        // 검색 입력 (엔터키)
        dialog.querySelector('#pm-user-search-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const dropdown = dialog.querySelector('#pm-user-search-dropdown');
                // 드롭다운이 열려있으면 document의 handleKeyDown에서 처리
                if (dropdown?.classList.contains('is-open')) {
                    return;
                }
                // 드롭다운이 닫혀있으면 검색 실행
                e.preventDefault();
                this.searchUsers(true);
            }
        });

        // 역할 변경 시 폴더 권한 자동 설정
        dialog.querySelector('#pm-new-role')?.addEventListener('change', (e) => {
            const role = e.target.value;
            const foldersInput = dialog.querySelector('#pm-new-folders');
            if (role === 'ADMIN' || role === 'SUPER') {
                foldersInput.value = '*';
                foldersInput.disabled = true;
            } else {
                foldersInput.disabled = false;
            }
        });

        // 배경 클릭 시 닫기
        dialog.addEventListener('click', (e) => {
            if (e.target === dialog) {
                this.closeCreateDialog();
            }
        });
    }

    /**
     * 키보드 이벤트 핸들러 (드롭다운 네비게이션)
     */
    handleKeyDown(event) {
        if (!this.createDialog) return;

        const dropdown = this.createDialog.querySelector('#pm-user-search-dropdown');
        if (!dropdown) return;

        // 드롭다운이 열려있을 때만 처리
        if (dropdown.classList.contains('is-open')) {
            const items = Array.from(dropdown.querySelectorAll('.pm-user-search-item'));
            if (items.length > 0) {
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    this.selectedUserSearchIndex = Math.min(this.selectedUserSearchIndex + 1, items.length - 1);
                    this.updateSearchSelection(items);
                    return;
                } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    this.selectedUserSearchIndex = Math.max(this.selectedUserSearchIndex - 1, -1);
                    this.updateSearchSelection(items);
                    return;
                } else if (event.key === 'Enter') {
                    event.preventDefault();
                    if (this.selectedUserSearchIndex >= 0 && this.selectedUserSearchIndex < items.length) {
                        const selectedItem = items[this.selectedUserSearchIndex];
                        const userData = JSON.parse(selectedItem.dataset.user);
                        this.fillUserData(userData);
                    } else if (this.selectedUserSearchIndex === -1 && items.length > 0) {
                        // 선택된 항목이 없으면 첫 번째 항목 선택
                        this.selectedUserSearchIndex = 0;
                        this.updateSearchSelection(items);
                        const firstItem = items[0];
                        const userData = JSON.parse(firstItem.dataset.user);
                        this.fillUserData(userData);
                    }
                    return;
                } else if (event.key === 'Escape') {
                    event.preventDefault();
                    this.hideSearchDropdown();
                    this.selectedUserSearchIndex = -1;
                    return;
                }
            }
        }

        // ESC 키: 다이얼로그 닫기
        if (event.key === 'Escape' && !dropdown?.classList.contains('is-open')) {
            event.preventDefault();
            this.closeCreateDialog();
            return;
        }
    }

    /**
     * 사용자 검색 (stats.json)
     */
    async searchUsers(shouldOpen = false) {
        const searchInput = this.createDialog?.querySelector('#pm-user-search-input');
        const dropdown = this.createDialog?.querySelector('#pm-user-search-dropdown');
        if (!searchInput || !dropdown) return;

        const query = searchInput.value.trim();
        if (!query) {
            dropdown.innerHTML = '<div class="pm-dropdown-empty">검색어를 입력하세요</div>';
            if (shouldOpen) {
                dropdown.classList.add('is-open');
                dropdown.setAttribute('aria-expanded', 'true');
            }
            return;
        }

        try {
            const res = await fetch(`/api/users/search?query=${encodeURIComponent(query)}&limit=10`);
            const data = await res.json();

            if (!data.success || !data.users || data.users.length === 0) {
                dropdown.innerHTML = '<div class="pm-dropdown-empty">검색 결과 없음</div>';
                if (shouldOpen) {
                    dropdown.classList.add('is-open');
                    dropdown.setAttribute('aria-expanded', 'true');
                }
                return;
            }

            // 검색 결과 렌더링
            dropdown.innerHTML = data.users.map((user, index) => {
                const userDataStr = JSON.stringify(user).replace(/"/g, '&quot;');
                return `
                    <div class="pm-user-search-item" data-user="${userDataStr}" data-index="${index}">
                        <div class="pm-user-search-name">${user.username}</div>
                        <div class="pm-user-search-info">
                            LoginId: ${user.login_id} | ${user.dept_name || '부서 없음'}
                        </div>
                    </div>
                `;
            }).join('');

            // 클릭 이벤트 바인딩
            dropdown.querySelectorAll('.pm-user-search-item').forEach((item, index) => {
                item.addEventListener('mouseenter', () => {
                    this.selectedUserSearchIndex = index;
                    this.updateSearchSelection(Array.from(dropdown.querySelectorAll('.pm-user-search-item')));
                });
                item.addEventListener('click', () => {
                    const userData = JSON.parse(item.dataset.user);
                    this.fillUserData(userData);
                });
            });

            if (shouldOpen) {
                dropdown.classList.add('is-open');
                dropdown.setAttribute('aria-expanded', 'true');
                this.selectedUserSearchIndex = 0;
                setTimeout(() => {
                    const items = Array.from(dropdown.querySelectorAll('.pm-user-search-item'));
                    if (items.length > 0) {
                        this.updateSearchSelection(items);
                    }
                }, 0);
            }
        } catch (error) {
            console.error('사용자 검색 오류:', error);
            dropdown.innerHTML = '<div class="pm-dropdown-empty">검색 오류 발생</div>';
        }
    }

    /**
     * 검색 결과 선택 상태 업데이트
     */
    updateSearchSelection(items) {
        items.forEach((item, index) => {
            if (index === this.selectedUserSearchIndex) {
                item.style.backgroundColor = '#007acc';
                item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            } else {
                item.style.backgroundColor = '';
            }
        });
    }

    /**
     * 검색 드롭다운 숨기기
     */
    hideSearchDropdown() {
        const dropdown = this.createDialog?.querySelector('#pm-user-search-dropdown');
        if (dropdown) {
            dropdown.classList.remove('is-open');
            dropdown.setAttribute('aria-expanded', 'false');
        }
    }

    /**
     * 검색 결과로 폼 자동 채우기
     */
    fillUserData(userData) {
        if (!this.createDialog) return;

        const usernameInput = this.createDialog.querySelector('#pm-new-username');
        const displayNameInput = this.createDialog.querySelector('#pm-new-displayname');
        const emailInput = this.createDialog.querySelector('#pm-new-email');

        if (usernameInput) usernameInput.value = userData.login_id || '';
        if (displayNameInput) displayNameInput.value = userData.username || '';
        if (emailInput && userData.dept_name) {
            // 이메일이 없으면 부서명으로 힌트 제공
            emailInput.placeholder = `${userData.dept_name}`;
        }

        this.hideSearchDropdown();
        this.selectedUserSearchIndex = -1;

        // 역할 선택 필드로 포커스 이동
        this.createDialog.querySelector('#pm-new-role')?.focus();
    }

    /**
     * 사용자 생성 처리
     */
    async handleCreateUser() {
        if (!this.createDialog) return;

        const username = this.createDialog.querySelector('#pm-new-username')?.value.trim();
        const displayName = this.createDialog.querySelector('#pm-new-displayname')?.value.trim();
        const email = this.createDialog.querySelector('#pm-new-email')?.value.trim();
        const role = this.createDialog.querySelector('#pm-new-role')?.value;
        const folders = this.createDialog.querySelector('#pm-new-folders')?.value.trim();
        const errorEl = this.createDialog.querySelector('#pm-dialog-error');

        // 유효성 검사
        if (!username) {
            errorEl.textContent = '사용자명(LoginId)을 입력하세요.';
            return;
        }
        if (!displayName) {
            errorEl.textContent = '표시 이름(Username)을 입력하세요.';
            return;
        }
        if (!role) {
            errorEl.textContent = '역할을 선택하세요.';
            return;
        }

        errorEl.textContent = '';

        // 사용자 생성
        await this.createUser(username, displayName, email, role, folders);
        this.closeCreateDialog();
    }

    /**
     * 사용자 생성
     */
    async createUser(username, displayName, email, role, folders = '') {
        try {
            const res = await fetch('/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username,
                    display_name: displayName,
                    email,
                    role,
                    folders
                })
            });

            const data = await res.json();

            if (data.success) {
                alert(`사용자 '${username}'이(가) 생성되었습니다.`);
                await this.loadUsers();
                this.renderUserList();
            } else {
                alert(`사용자 생성 실패: ${JSON.stringify(data)}`);
            }
        } catch (error) {
            console.error('사용자 생성 오류:', error);
            alert(`사용자 생성 오류: ${error.message}`);
        }
    }

    /**
     * 역할 변경
     */
    async updateUserRole() {
        if (!this.selectedUser) return;

        const newRole = document.getElementById('pm-role-select')?.value;
        if (!newRole) return;

        if (!confirm(`'${this.selectedUser.username}'의 역할을 '${newRole}'(으)로 변경하시겠습니까?`)) {
            return;
        }

        try {
            const res = await fetch(`/api/users/${this.selectedUser.username}/role`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ new_role: newRole })
            });

            const data = await res.json();

            if (data.success) {
                alert('역할이 변경되었습니다.');
                await this.loadUsers();
                await this.selectUser(this.selectedUser.username);
            } else {
                alert(`역할 변경 실패: ${JSON.stringify(data)}`);
            }
        } catch (error) {
            console.error('역할 변경 오류:', error);
            alert(`역할 변경 오류: ${error.message}`);
        }
    }

    /**
     * 폴더 권한 추가 다이얼로그
     */
    showAddGrantDialog() {
        if (!this.selectedUser) return;

        const folder = prompt('폴더 경로:');
        if (!folder) return;

        const level = prompt('권한 레벨 (USER/POWER/ADMIN/SUPER):', 'POWER');
        if (!level) return;

        this.addGrant(folder, level);
    }

    /**
     * 폴더 권한 추가
     */
    async addGrant(folder, level) {
        if (!this.selectedUser) return;

        try {
            const res = await fetch(`/api/users/${this.selectedUser.username}/grants`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder, level })
            });

            const data = await res.json();

            if (data.success) {
                alert('폴더 권한이 추가되었습니다.');
                await this.selectUser(this.selectedUser.username);
            } else {
                alert(`권한 추가 실패: ${JSON.stringify(data)}`);
            }
        } catch (error) {
            console.error('권한 추가 오류:', error);
            alert(`권한 추가 오류: ${error.message}`);
        }
    }

    /**
     * 폴더 권한 제거
     */
    async removeGrant(folder) {
        if (!this.selectedUser) return;

        if (!confirm(`폴더 '${folder}'에 대한 권한을 제거하시겠습니까?`)) {
            return;
        }

        try {
            const res = await fetch(`/api/users/${this.selectedUser.username}/grants`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder })
            });

            const data = await res.json();

            if (data.success) {
                alert('폴더 권한이 제거되었습니다.');
                await this.selectUser(this.selectedUser.username);
            } else {
                alert(`권한 제거 실패: ${JSON.stringify(data)}`);
            }
        } catch (error) {
            console.error('권한 제거 오류:', error);
            alert(`권한 제거 오류: ${error.message}`);
        }
    }

    /**
     * 사용자 삭제
     */
    async deleteUser() {
        if (!this.selectedUser) return;

        if (!confirm(`사용자 '${this.selectedUser.username}'을(를) 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) {
            return;
        }

        try {
            const res = await fetch(`/api/users/${this.selectedUser.username}`, {
                method: 'DELETE'
            });

            const data = await res.json();

            if (data.success) {
                alert('사용자가 삭제되었습니다.');
                this.selectedUser = null;
                await this.loadUsers();
                this.renderUserList();
                document.getElementById('pm-user-details').innerHTML = '<p class="placeholder">사용자를 선택하세요</p>';
            } else {
                alert(`사용자 삭제 실패: ${JSON.stringify(data)}`);
            }
        } catch (error) {
            console.error('사용자 삭제 오류:', error);
            alert(`사용자 삭제 오류: ${error.message}`);
        }
    }

    /**
     * 감사 로그 조회
     */
    async loadAuditLogs(date = null, limit = 100) {
        try {
            const url = new URL('/api/audit-logs', window.location.origin);
            if (date) url.searchParams.set('date', date);
            url.searchParams.set('limit', limit);

            const res = await fetch(url);
            const data = await res.json();

            if (data.success) {
                this.auditLogs = data.logs || [];
                this.renderAuditLogs();
            } else {
                alert(`감사 로그 조회 실패: ${JSON.stringify(data)}`);
            }
        } catch (error) {
            console.error('감사 로그 조회 오류:', error);
            alert(`감사 로그 조회 오류: ${error.message}`);
        }
    }

    /**
     * 감사 로그 렌더링
     */
    renderAuditLogs() {
        const container = document.getElementById('pm-audit-logs');
        if (!container) return;

        if (this.auditLogs.length === 0) {
            container.innerHTML = '<p class="empty">감사 로그가 없습니다.</p>';
            return;
        }

        container.innerHTML = `
            <table class="audit-table">
                <thead>
                    <tr>
                        <th>시간</th>
                        <th>작업자</th>
                        <th>액션</th>
                        <th>대상</th>
                        <th>상세</th>
                    </tr>
                </thead>
                <tbody>
                    ${this.auditLogs.map(log => `
                        <tr>
                            <td>${new Date(log.timestamp).toLocaleString('ko-KR')}</td>
                            <td>${log.actor}</td>
                            <td><span class="action-badge">${log.action}</span></td>
                            <td>${log.target}</td>
                            <td>${JSON.stringify(log.details)}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    /**
     * 권한 배지 표시 (버튼 옆에)
     */
    showPermissionBadge(element, permission) {
        const badge = document.createElement('span');
        badge.className = `permission-badge permission-${permission.toLowerCase()}`;
        badge.textContent = permission;
        badge.title = `${permission} 권한 필요`;

        element.insertAdjacentElement('afterend', badge);
    }

    /**
     * 버튼 비활성화 (권한 없음)
     */
    disableButton(element, reason) {
        element.disabled = true;
        element.title = reason;
        element.style.opacity = '0.5';
        element.style.cursor = 'not-allowed';
    }
}
