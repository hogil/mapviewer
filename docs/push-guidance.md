# GitHub 푸시 안내

현재 저장소에는 GitHub 원격(remote) 설정이 없어서 `git push`를 바로 실행할 수 없습니다. 또한 이 컨테이너 환경은 외부 네트워크 접속이
차단될 수 있어, 원격을 추가해도 푸시가 실패할 수 있습니다. GitHub에 업데이트하려면 아래 순서를 따라 진행하세요.

1. **원격 확인**: `git remote -v` 명령으로 원격이 비어 있는지 확인합니다.
2. **GitHub 리포지터리 생성**: HTTPS 또는 SSH URL을 준비합니다.
3. **원격 추가**
   - HTTPS: `git remote add origin https://github.com/<OWNER>/<REPO>.git`
   - SSH: `git remote add origin git@github.com:<OWNER>/<REPO>.git`
4. **브랜치 지정 푸시**
   - 예시: `git push -u origin work` (현재 브랜치 이름으로 교체)
5. **인증 처리**
   - HTTPS: GitHub 토큰(PAT)을 비밀번호로 입력
   - SSH: 공개키를 GitHub에 등록 후 사용

## 네트워크 제한 시 대안
- 컨테이너에서 방화벽·정책으로 외부 접속이 막히는 경우, 로컬 PC 또는 사내 네트워크 등 허용된 환경에서 푸시합니다.
- 절차 예시
  1) 로컬에서 동일 리포지터리를 클론
  2) 컨테이너에서 변경분을 번들로 내보내기: `git bundle create changes.bundle HEAD`
  3) 로컬 저장소에서 적용: `git pull --ff-only ../changes.bundle`
  4) 로컬에서 `git push` 실행 (또는 변경 파일만 복사해 로컬에서 커밋 후 푸시)

필요 시 네트워크 정책(프록시, 방화벽)이나 인증 설정을 확인한 뒤 다시 시도하세요.

## 현재 컨테이너 점검 결과
- `git remote -v` 결과: 원격이 비어 있어 즉시 `git push`를 실행할 수 없습니다.
- 외부 네트워크 접속 차단 여부는 알 수 없으므로, 원격 추가 후 `git push -u origin <브랜치>` 시 인증/네트워크 오류가 발생할 수 있습니다.
- 번들 대안 검증: `git bundle create /tmp/mapviewer.bundle HEAD`를 실행해 내보내기가 정상 동작함을 확인했습니다. 생성된 번들을 로컬/사내 환경으로 옮긴 뒤 `git pull --ff-only /tmp/mapviewer.bundle` 또는 `git fetch /tmp/mapviewer.bundle <브랜치>`로 적용 후 푸시하세요.
- 원격이 없는 상태에서 `git push`를 실행하면 “No configured push destination” 오류가 발생합니다. 원격 URL을 추가한 뒤 다시 푸시를 시도해야 합니다.
