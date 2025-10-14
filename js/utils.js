/**
 * 유틸리티 함수들
 * 파일 처리, 경로 처리, 일반적인 헬퍼 함수들
 */

/**
 * 이미지 파일인지 확인
 * @param {string} filePath 파일 경로
 * @returns {boolean} 이미지 파일 여부
 */
export function isImageFile(filePath) {
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif'];
    const extension = filePath.toLowerCase().substring(filePath.lastIndexOf('.'));
    return imageExtensions.includes(extension);
}

/**
 * 파일 경로에서 폴더명 추출
 * @param {string} filePath 파일 경로
 * @returns {string} 폴더명 (최상위면 'ROOT')
 */
export function extractFolderName(filePath) {
    const pathParts = filePath.split('/');
    return pathParts.length > 1 ? pathParts[pathParts.length - 2] : 'ROOT';
}

/**
 * 파일 경로에서 파일명 추출 (확장자 제거)
 * @param {string} filePath 파일 경로
 * @returns {string} 파일명 (확장자 없음)
 */
export function extractFileName(filePath) {
    const pathParts = filePath.split('/');
    const fileName = pathParts[pathParts.length - 1];
    return fileName.replace(/\.[^/.]+$/, '');
}

/**
 * 파일명을 언더스코어로 분할
 * @param {string} fileName 파일명
 * @param {number} maxParts 최대 분할 개수 (기본: 5)
 * @returns {Array<string>} 분할된 부분들
 */
export function splitFileName(fileName, maxParts = 5) {
    const parts = fileName.split('_');
    const result = [];
    for (let i = 0; i < maxParts; i++) {
        result.push(parts[i] || '');
    }
    return result;
}

/**
 * 디바운싱 함수
 * @param {Function} func 실행할 함수
 * @param {number} delay 지연 시간 (ms)
 * @returns {Function} 디바운싱된 함수
 */
export function debounce(func, delay) {
    let timeoutId;
    return function (...args) {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => func.apply(this, args), delay);
    };
}

/**
 * 요소가 뷰포트에 보이는지 확인
 * @param {Element} element DOM 요소
 * @returns {boolean} 보이는지 여부
 */
export function isElementVisible(element) {
    const rect = element.getBoundingClientRect();
    return (
        rect.top >= 0 &&
        rect.left >= 0 &&
        rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
        rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
}

/**
 * 클립보드에 텍스트 복사
 * @param {string} text 복사할 텍스트
 * @returns {Promise<boolean>} 성공 여부
 */
export async function copyToClipboard(text) {
    try {
        if (navigator.clipboard) {
            await navigator.clipboard.writeText(text);
            return true;
        } else {
            // 폴백: 임시 textarea 생성
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            const success = document.execCommand('copy');
            document.body.removeChild(textarea);
            return success;
        }
    } catch (error) {
        console.error('클립보드 복사 실패:', error);
        return false;
    }
}

/**
 * 배열을 청크로 분할
 * @param {Array} array 원본 배열
 * @param {number} chunkSize 청크 크기
 * @returns {Array<Array>} 분할된 배열들
 */
export function chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
        chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
}

/**
 * 그리드 크기 계산 (정사각형에 가까운 배치)
 * @param {number} count 아이템 개수
 * @returns {Object} {cols, rows} 그리드 크기
 */
export function calculateGridSize(count) {
    if (count <= 0) return { cols: 0, rows: 0 };
    if (count === 1) return { cols: 1, rows: 1 };
    
    const sqrt = Math.sqrt(count);
    const cols = Math.ceil(sqrt);
    const rows = Math.ceil(count / cols);
    
    return { cols, rows };
}

/**
 * 안전한 JSON 파싱
 * @param {string} jsonString JSON 문자열
 * @param {*} defaultValue 기본값
 * @returns {*} 파싱된 객체 또는 기본값
 */
export function safeJsonParse(jsonString, defaultValue = null) {
    try {
        return JSON.parse(jsonString);
    } catch (error) {
        console.warn('JSON 파싱 실패:', error);
        return defaultValue;
    }
}

/**
 * 로딩 상태 표시/숨김
 * @param {Element} button 버튼 요소
 * @param {boolean} loading 로딩 상태
 * @param {string} originalText 원본 텍스트
 * @param {string} loadingText 로딩 텍스트
 */
export function setButtonLoading(button, loading, originalText = '', loadingText = '처리 중...') {
    if (loading) {
        button.disabled = true;
        button.style.opacity = '0.6';
        if (originalText) {
            button.textContent = loadingText;
        }
    } else {
        button.disabled = false;
        button.style.opacity = '1';
        if (originalText) {
            button.textContent = originalText;
        }
    }
}
