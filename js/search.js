/**
 * 검색 관련 기능들
 * 고급 검색, 표현식 파싱, 파일 필터링
 */

/**
 * 검색 표현식을 평가하여 파일명이 매치되는지 확인
 * @param {string} fileName 파일명
 * @param {string} query 검색 쿼리
 * @returns {boolean} 매치 여부
 */
export function matchesSearchQuery(fileName, query) {
    if (!query || !query.trim()) return true;

    // 🔥 stime(날짜_시간) 부분 제거하여 검색 — AND 시 timestamp 오매칭 방지
    // 파일명: {LOT}_{STEP}_{WAFER}_{YYYYMMDD}_{HHMMSS}_{yield}_{sys}_{LT}_{TM}.ext
    // 날짜(8자리숫자)_시간(6자리숫자) 패턴 제거
    const normalizedFileName = fileName.toLowerCase().replace(/\d{8}_\d{6}_?/g, '');
    const normalizedQuery = query.toLowerCase().trim();

    try {
        return evaluateExpression(normalizedFileName, normalizedQuery);
    } catch (error) {
        console.warn('검색 표현식 오류, 기본 검색으로 폴백:', error);
        return normalizedFileName.includes(normalizedQuery);
    }
}

/**
 * 표현식을 평가 (괄호, OR 연산자 처리)
 * @param {string} fileName 파일명
 * @param {string} expression 표현식
 * @returns {boolean} 평가 결과
 */
function evaluateExpression(fileName, expression) {
    // 괄호 처리
    while (expression.includes('(')) {
        const start = expression.lastIndexOf('(');
        const end = expression.indexOf(')', start);
        if (end === -1) break;
        
        const subExpression = expression.substring(start + 1, end);
        const result = evaluateExpression(fileName, subExpression);
        expression = expression.substring(0, start) + result + expression.substring(end + 1);
    }
    
    // OR 연산자로 분할하여 처리
    const orTerms = splitByOperator(expression, 'or');
    if (orTerms.length > 1) {
        return orTerms.some(term => evaluateAndExpression(fileName, term.trim()));
    }
    
    return evaluateAndExpression(fileName, expression);
}

/**
 * AND 표현식 평가
 * @param {string} fileName 파일명
 * @param {string} expression 표현식
 * @returns {boolean} 평가 결과
 */
function evaluateAndExpression(fileName, expression) {
    const andTerms = splitByOperator(expression, 'and');
    return andTerms.every(term => evaluateNotExpression(fileName, term.trim()));
}

/**
 * NOT 표현식 평가
 * @param {string} fileName 파일명
 * @param {string} expression 표현식
 * @returns {boolean} 평가 결과
 */
function evaluateNotExpression(fileName, expression) {
    if (expression.startsWith('not ')) {
        const term = expression.substring(4).trim();
        return !evaluateBasicTerm(fileName, term);
    }
    return evaluateBasicTerm(fileName, expression);
}

/**
 * 기본 용어 평가 (포함 검사)
 * @param {string} fileName 파일명
 * @param {string} term 검색 용어
 * @returns {boolean} 평가 결과
 */
function evaluateBasicTerm(fileName, term) {
    if (!term) return true;
    return fileName.includes(term);
}

/**
 * LOT 기반 슬래시 검색 (정확한 매칭)
 * @param {string} filePath 파일 경로
 * @param {string} lotQuery 슬래시로 구분된 LOT 목록 (예: "LOT001/LOT002/LOT003")
 * @returns {boolean} 매치 여부
 */
export function matchesLotSlashQuery(filePath, lotQuery) {
    if (!lotQuery || !lotQuery.trim()) return true;

    // 슬래시로 분리하여 Set 생성
    const lotSet = new Set(lotQuery.split('/').map(lot => lot.trim().toLowerCase()).filter(lot => lot));

    if (lotSet.size === 0) return true;

    // 파일명에서 LOT 추출
    const fileName = filePath.split('/').pop().split('\\').pop();
    const baseName = fileName.replace(/\.[^/.]+$/, '');
    const parts = baseName.split('_');

    if (parts.length < 1) return false;

    const lotValue = parts[0].toLowerCase();

    // Set에서 O(1) 조회
    return lotSet.has(lotValue);
}

/**
 * 여러 파일에서 LOT 기반 슬래시 검색
 * @param {string} lotQuery 슬래시로 구분된 LOT 목록
 * @param {Array<string>} filePaths 파일 경로 배열
 * @returns {Array<string>} 매치된 파일 경로들
 */
export function searchByLotSlash(lotQuery, filePaths) {
    if (!lotQuery || !lotQuery.trim()) return [];

    const lotSet = new Set(lotQuery.split('/').map(lot => lot.trim().toLowerCase()).filter(lot => lot));

    if (lotSet.size === 0) return [];

    const matchedFiles = [];

    for (const filePath of filePaths) {
        const fileName = filePath.split('/').pop().split('\\').pop();
        const baseName = fileName.replace(/\.[^/.]+$/, '');
        const parts = baseName.split('_');

        if (parts.length >= 1) {
            const lotValue = parts[0].toLowerCase();
            if (lotSet.has(lotValue)) {
                matchedFiles.push(filePath);
            }
        }
    }

    return matchedFiles;
}

/**
 * 연산자로 문자열 분할 (대소문자 무시, 단어 경계 고려)
 * @param {string} text 텍스트
 * @param {string} operator 연산자
 * @returns {Array<string>} 분할된 부분들
 */
function splitByOperator(text, operator) {
    const regex = new RegExp(`\\b${operator}\\b`, 'gi');
    return text.split(regex).filter(part => part.trim());
}

/**
 * DOM에서 빠른 파일명 검색
 * @param {string} query 검색 쿼리
 * @param {Element} container 검색할 컨테이너
 * @returns {Array<string>} 매치된 파일 경로들
 */
export function fastFileNameSearch(query, container) {
    if (!query || !query.trim()) {
        return [];
    }
    
    const matchedFiles = [];
    
    // 모든 파일 링크 검색
    const fileLinks = container.querySelectorAll('a[data-path]');
    
    fileLinks.forEach(link => {
        const filePath = link.getAttribute('data-path');
        const fileName = filePath.split('/').pop(); // 파일명만 추출
        
        if (matchesSearchQuery(fileName, query)) {
            matchedFiles.push(filePath);
        }
    });
    
    return matchedFiles;
}

/**
 * 검색 결과 하이라이팅
 * @param {string} text 원본 텍스트
 * @param {string} query 검색 쿼리
 * @returns {string} 하이라이팅된 HTML
 */
export function highlightSearchResult(text, query) {
    if (!query || !query.trim()) return text;
    
    // 기본 검색어 하이라이팅 (복잡한 표현식은 제외)
    const simpleQuery = query.replace(/\b(and|or|not)\b|\(|\)/gi, '').trim();
    if (!simpleQuery) return text;
    
    const terms = simpleQuery.split(/\s+/).filter(term => term.length > 0);
    let highlightedText = text;
    
    terms.forEach(term => {
        const regex = new RegExp(`(${escapeRegExp(term)})`, 'gi');
        highlightedText = highlightedText.replace(regex, '<mark>$1</mark>');
    });
    
    return highlightedText;
}

/**
 * 정규식 특수문자 이스케이프
 * @param {string} string 문자열
 * @returns {string} 이스케이프된 문자열
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 검색 쿼리 유효성 검사
 * @param {string} query 검색 쿼리
 * @returns {Object} {valid: boolean, error: string}
 */
export function validateSearchQuery(query) {
    if (!query || !query.trim()) {
        return { valid: true, error: '' };
    }
    
    // 괄호 균형 검사
    let openParens = 0;
    for (const char of query) {
        if (char === '(') openParens++;
        if (char === ')') openParens--;
        if (openParens < 0) {
            return { valid: false, error: '괄호가 올바르지 않습니다.' };
        }
    }
    
    if (openParens !== 0) {
        return { valid: false, error: '괄호가 닫히지 않았습니다.' };
    }
    
    return { valid: true, error: '' };
}

/**
 * 검색 히스토리 관리
 */
export class SearchHistory {
    constructor(maxSize = 10) {
        this.maxSize = maxSize;
        this.history = this.loadFromStorage();
    }
    
    /**
     * 검색어 추가
     * @param {string} query 검색어
     */
    add(query) {
        if (!query || !query.trim()) return;
        
        const trimmedQuery = query.trim();
        
        // 중복 제거
        this.history = this.history.filter(item => item !== trimmedQuery);
        
        // 맨 앞에 추가
        this.history.unshift(trimmedQuery);
        
        // 크기 제한
        if (this.history.length > this.maxSize) {
            this.history = this.history.slice(0, this.maxSize);
        }
        
        this.saveToStorage();
    }
    
    /**
     * 히스토리 가져오기
     * @returns {Array<string>} 검색 히스토리
     */
    getHistory() {
        return [...this.history];
    }
    
    /**
     * 히스토리 지우기
     */
    clear() {
        this.history = [];
        this.saveToStorage();
    }
    
    /**
     * 로컬 스토리지에서 로드
     * @returns {Array<string>} 히스토리
     */
    loadFromStorage() {
        try {
            const stored = localStorage.getItem('wafer-map-search-history');
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.warn('검색 히스토리 로드 실패:', error);
            return [];
        }
    }
    
    /**
     * 로컬 스토리지에 저장
     */
    saveToStorage() {
        try {
            localStorage.setItem('wafer-map-search-history', JSON.stringify(this.history));
        } catch (error) {
            console.warn('검색 히스토리 저장 실패:', error);
        }
    }
}
