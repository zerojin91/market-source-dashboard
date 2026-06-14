# Market Source Dashboard

KOSPI LAB과 eSignal의 공개 페이지를 한 화면에서 보는 10초 갱신 대시보드입니다.

## 포함 데이터

- KOSPI, 삼성전자, SK하이닉스: `https://kospilab.com/`
- KOSDAQ: KOSPI LAB이 명시한 원천 데이터인 네이버 금융 fallback
- NASDAQ, S&P 500: KOSPI LAB이 명시한 원천 데이터인 Yahoo Finance fallback
- 코스피 200 야간 선물: `https://esignal.co.kr/kospi200-futures-night/`

## 실행

```bash
npm start
```

브라우저에서 `http://localhost:3000`을 엽니다.

개발 중 자동 재시작이 필요하면:

```bash
npm run dev
```

## 구조

```text
public/
  index.html   # 대시보드 화면
  styles.css   # 반응형 UI 스타일
  app.js       # 10초 폴링 및 eSignal socket.io 보강
server/
  index.js     # 정적 파일 서버 및 /api/quotes 프록시 API
```

## GitHub 업로드

```bash
git add .
git commit -m "Initial market dashboard"
git branch -M main
git remote add origin https://github.com/<YOUR_ID>/<REPO_NAME>.git
git push -u origin main
```

외부 사이트 HTML/API 구조가 바뀌면 `server/index.js`의 파서 또는 fallback URL을 조정해야 합니다.
