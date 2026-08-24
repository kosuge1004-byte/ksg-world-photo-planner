# 有名スポット自動キャッシュ機能(prewarm Worker)を有効にする手順

ターミナルやコマンド操作は一切不要です。すべてブラウザの画面操作だけで完結します。
「GitHubにコードをプッシュすると自動でCloudflareがビルドする」という、
今すでに動いている仕組み(AstroSight本体のPagesデプロイ)と同じ形を、
このWorkerにも1回だけ設定します。設定してしまえば、以後は今まで通り
GitHubにプッシュするだけで自動的に更新されます。

---

## 手順1: Cloudflareで「APIトークン」を作る

1. https://dash.cloudflare.com にログイン
2. 右上のアカウントアイコン → 「マイプロフィール」(My Profile)
3. 左メニューの「APIトークン」(API Tokens)を開く
4. 「トークンを作成する」(Create Token) をクリック
5. 一覧の中から「Edit Cloudflare Workers」というテンプレートを探して
   「テンプレートを使用する」(Use template) をクリック
6. 内容はそのままで一番下までスクロールし、「概要に進む」→
   「トークンを作成する」をクリック
7. 表示された長い文字列(トークン)を **コピーしてどこかに一時的に保存**
   しておく(この画面を閉じると二度と表示されません)

## 手順2: GitHubにそのトークンを登録する

1. https://github.com にログインし、AstroSightのリポジトリ
   (`ksg-world-photo-planner`)を開く
2. リポジトリ画面上部の「Settings」タブを開く
3. 左メニューの「Secrets and variables」→「Actions」を開く
4. 「New repository secret」をクリック
5. 以下のように入力:
   - Name: `CLOUDFLARE_API_TOKEN`
   - Secret: 手順1でコピーしたトークンを貼り付け
6. 「Add secret」で保存

## 手順3: このzipの内容をGitHubに反映する

このzipには、手順1・2の設定さえ済んでいれば自動的にWorkerを
デプロイしてくれる設定ファイル(`.github/workflows/deploy-prewarm-worker.yml`)
と、有効化済みの`workers/prewarm-landmark-cron.ts`が入っています。
このzipの中身で、GitHub上のリポジトリを今まで通り更新(コミット・プッシュ)
してください。

プッシュが完了すると、GitHubが自動的にCloudflareへWorkerをデプロイします。
進み具合は、リポジトリの「Actions」タブから確認できます
(緑のチェックが付けば成功です)。

## 手順4: 動いているか確認する

1. Cloudflareダッシュボード → 「Workers & Pages」を開く
2. `astrosight-prewarm-landmark-cron` が一覧に表示されていればデプロイ成功
3. そのWorkerを開き、「トリガー」(Triggers) タブに
   `0 18 * * *` というCronトリガーが表示されていれば、
   毎日日本時間 深夜3:00 に自動実行される設定になっています
4. すぐに動作確認したい場合は、Worker詳細画面に表示される
   URL(`https://astrosight-prewarm-landmark-cron.<あなたのサブドメイン>.workers.dev`)
   にブラウザでアクセスすると、その場で1回分(8件)を試して結果を
   ログとして画面に表示します

---

以降は、この機能に関するコード(`workers/prewarm-landmark-cron.ts`など)を
変更してGitHubにプッシュするたびに、自動で再デプロイされます。
