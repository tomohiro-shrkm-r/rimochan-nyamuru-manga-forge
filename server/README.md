# manga-forge-server

`scripts/forge.sh` を HTTP から呼ぶ、**自分用のローカルAPIサーバー**です（Hono + TypeScript）。
認証はありません。`127.0.0.1` だけで待ち受けます。

## 起動

```
cd server
npm install    # 初回のみ
npm start      # http://127.0.0.1:8787
```

- Swagger UI: http://127.0.0.1:8787/docs
- OpenAPI 仕様: http://127.0.0.1:8787/openapi.json

API の使い方（エンドポイントや入力項目）は Swagger UI を見てください。

## 設定（環境変数）

| 変数 | 既定 | 内容 |
|---|---|---|
| `PORT` | `8787` | 待受ポート |
| `BASH_PATH` | `C:\Program Files\Git\bin\bash.exe` | `forge.sh` を動かす Git Bash。Windows の `System32\bash.exe`（WSL）は使わない |

例: `PORT=9000 npm start`（PowerShell: `$env:PORT=9000; npm start`）

## 動き方

- ジョブは1件ずつ直列に実行します（codex のレート制限対策）。
- ジョブごとに `out/<job_id>/` を作り、入力は `input/`、状態は `job.json`、成果物は `pageN.png` に置きます。
- サーバー再起動時、途中だったジョブは `failed`（サーバー再起動により中断）になります。
- 完了通知はありません。`GET /jobs/{id}` をポーリングしてください。

## 他の端末から使う（Tailscale）

サーバーは `127.0.0.1` のまま、`tailscale serve` で tailnet 内の端末にだけ公開します。
認証が無いため、`0.0.0.0` への変更や `tailscale funnel`（インターネット公開）はしないでください。

```
tailscale serve --bg --https=443 http://127.0.0.1:8787   # 公開
tailscale serve status                                   # 確認
tailscale serve --https=443 off                          # 停止
```

tailnet 側で Serve 機能を有効にしておく必要があります。

### 公開URLの調べ方

URL は `https://<このPCの名前>.<tailnet名>.ts.net` という形で、`tailscale serve status` の1行目に出ます。

```
$ tailscale serve status
https://<このPCの名前>.<tailnet名>.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:8787
```

- Swagger UI は、その URL の末尾に `/docs` を付けたものです。
- tailnet 名は Tailscale の管理画面（https://login.tailscale.com/admin/dns）でも確認できます。
- 公開URLは個人の環境ごとに違うため、この README には書きません。
