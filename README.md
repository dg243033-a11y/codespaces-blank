# Simple Notifier

使い方:

- デモ（3秒後に通知）:

```
npm run demo
```

- 任意の日時で通知:

```
node index.js 2026-06-16 14:30 "会議"
```

- すぐ（ミリ秒指定）:

```
node index.js now 5000 "テスト通知"
```

- 声の種類を指定する:

```
node index.js now 5000 "テスト通知" --voice "kyoko"
```

`voice` は実行環境の TTS エンジンでサポートされる名前を指定します。

- 癒しの音楽を流す:

```
node index.js now 5000 "休憩時間" --music ./healing.mp3
```

`--music` で MP3 または WAV ファイルを指定すると、通知時に音楽が再生されます。

- 毎日の就寝時刻にアラートを送る:

```
node index.js --sleep 23:00 --music ./healing.wav
```

`--sleep HH:MM` で毎日指定時刻に就寝アラートが送られます。音声または音楽と組み合わせられます。

- 就寝リマインダーを停止する:

```
node index.js --stop-sleep
```

- 睡眠データをエクスポート（SleepSync）する:

```
node index.js --sleep-sync
```

- SleepSyncファイルをインポートする:

```
node index.js --sleep-sync-import ./sleep_sessions_sync.json
```

## Web公開

このプロジェクトには静的ページと、イベント保存用の簡易 Node サーバーが含まれています。

### 1. ローカルで公開する

1. 依存関係をインストール:
```
npm install
```
2. サーバーを起動:
```
npm start
```
3. ブラウザで開く:
```
http://localhost:3000/calendar.html
```

`calendar.html` からイベント管理と `/events` API の利用ができます。

### 2. 静的サイトとして公開する

`calendar.html`、`daily_activity.html`、`monthly_calendar.html` は静的ファイルとして公開できます。サーバーが使えない場合は、ブラウザの `localStorage` による保存が優先されます。

### 3. 公開先の例

- Node 実行可能なホスト: Railway、Render、Fly.io、Heroku、Vercel (Node)、Google Cloud Run など
- 静的サイト: GitHub Pages、Netlify、Vercel の静的ホスティング

### 4. GitHub Pages で静的に公開する場合

1. リポジトリを GitHub にプッシュ
2. GitHub Pages を有効にし、公開先を `main` ブランチのルートに設定
3. `https://<ユーザー名>.github.io/<リポジトリ名>/` を開く

このリポジトリには `index.html` を用意しているので、ルート URL でアクセスできます。

- `calendar.html` は予定管理ページです。サーバーの `/events` API が使えない場合は、自動的に `localStorage` に保存します。
- `daily_activity.html` と `monthly_calendar.html` も静的ページとして公開できます。

> iPad 上の Safari やブラウザから直接アクセスする場合、Node サーバーを実行する必要がない GitHub Pages 方式がもっとも簡単です。

## アクティビティトラッキング（1日の活動を円グラフで表示）

毎日の活動を記録して、円グラフで可視化できます。日本の時刻（JST）で自動的に管理されます。

- 活動を記録する:

```
node index.js --log-activity "仕事" 480 "プロジェクトコーディング"
node index.js --log-activity "睡眠" 480
node index.js --log-activity "休憩" 240
node index.js --log-activity "食事" 120
```

カテゴリ、時間（分）、詳細を指定します。

- 1日の活動を円グラフで表示:

```
node index.js --show-chart
```

`daily_activity.html` が生成されます。ブラウザで開くと、カラフルな円グラフが表示されます。

