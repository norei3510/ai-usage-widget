# AI Usage — 検証記録

検証日: 2026-10-07（日本時間）。配布版: 1.0。

**実装・自動検証は完了。認証情報を使う実API試験とiPhone実機試験は未実施です。両サービスの実データ同時表示が確認されるまで、全体の受入完了ではありません。**

## 検証環境と実施結果

Windows上のNode.js v22.17.0組込みテストランナーで、配布用 `AI Usage.js` の関数をそのまま読み込みました。テスト内の資格情報はすべて合成データです。通信はすべてモックで、実APIへアクセスしません。

```powershell
$env:TZ = 'Asia/Tokyo'
node --test outputs/tests/test.cjs
```

最終実行: **37テスト成功、失敗0、スキップ0**。HTTP失敗時にScriptableが例外を返す場合、更新間隔の設定、キー削除の確認画面も検証しました。README内のPowerShellコード3ブロックの構文解析も成功しました（ログイン操作は未実行）。配布スクリプトにconsoleログ、埋め込み初期トークン、第三者中継URLがないことも確認しました。

| 要件ID | 自動検証の内容 | 実機・実APIで残る確認 |
| --- | --- | --- |
| A01 | 両サービスのfixtureの取得・正規化・表示経路 | 実アカウントと管理画面との照合 |
| A02 | 使用率0/1/20/50/100と残量色の20/50境界 | 端末上の見た目 |
| A03 | undefined/null/空文字/数値文字列/boolean/NaN/Infinity/負数/100超/未知形式 | 実APIが新形式を返す場合の診断 |
| A04 | Unix秒・明示ミリ秒・ISO・相対秒・キャッシュでのリセット固定 | 実APIの日付と端末時刻の一致 |
| A05 | 並行取得、一方の失敗、前回値・正常取得日時の維持 | iPhoneでの通信失敗時の表示 |
| A06 | 両方未設定・設定キャンセル・通信失敗・案内表示 | iOSによる実行制限下の動作 |
| A07 | 期限切れ、401後の成功/再401、更新拒否、即時保存、保存値再読込み | 実トークンの更新・再認証 |
| A08 | 429の永続待機、Retry-After秒/HTTP日時、403/5xx/非JSON/通信例外の区別 | 実際のHTTP失敗と待機表示 |
| A09 | 30分の境界、別日・別年・日本時間の表示 | 端末設定と日付またぎ |
| A10 | 320/375/393/430ptのAPIモック実行、全5枠、小/大の案内 | 実機の明暗テーマ、文字切れ・重なり（未検証） |
| A11 | 有効/期限切れロック、競合後の保存値変化、更新前の再読込み | 実機での重複実行、原子的排他の限界 |
| A12 | 合成秘密・不明キー名がキャッシュ/診断に出ないこと | 導入後の端末上の保存状態 |

APIモックは描画オブジェクトへのアクセスを確認します。iOSのレンダリングやフォント幅を再現していないため、A10を実機合格とは扱いません。共有用診断は、既知フィールドの型・HTTPステータス・短い状態だけを出力します。

## API形式の根拠（2026-10-07確認）

### Codex

[元ウィジェット、コミット b12004e](https://github.com/yoyocircle/codex-usage-widget/blob/b12004ef3655c21c8e93ea0e49c75582df5ee6fa/codex-usage-widget.js)の公開実装を確認しました。

| 内容 | 採用した方式 |
| --- | --- |
| 利用状況 | GET `https://chatgpt.com/backend-api/wham/usage` |
| ヘッダー | Bearer access token、`ChatGPT-Account-Id` |
| トークン更新 | POST `https://auth.openai.com/oauth/token`、form-urlencoded、refresh_token grant |
| 公開client ID | `app_EMoamEEZ73f0CkXaXp7hrann`（秘密情報ではない） |
| Keychain | 元ウィジェットと同じ3キー |
| 枠 | `rate_limit.primary_window / secondary_window` の `limit_window_seconds` で識別 |
| 数値・リセット | `used_percent`、`reset_at`（秒）または `reset_after_seconds` |

実利用中のiPhoneソースそのものは取得していません。ユーザーがこのリポジトリのJSを導入し、残量表示済みと確認しています。改変版・旧版でキー名や期間が異なる場合は、導入後の診断で確認が必要です。

[OpenAI公式の認証資料](https://learn.chatgpt.com/docs/auth)も参照しました。上記wham利用状況エンドポイントの安定した公開API契約は、この資料から確立できていません。ここでの根拠は既存実装であり、OpenAIが互換性を保証していると扱いません。

### OpenCode Go

[OpenCode公式ソース、コミット ecc4916](https://github.com/anomalyco/opencode/blob/ecc4916b5a9608c30e6dd58a67f2137b594407ca/packages/console/app/src/routes/zen/go/v1/usage.ts)を取得して確認しました。

| 内容 | ソースで確認した方式 |
| --- | --- |
| 利用状況 | GET `https://opencode.ai/zen/go/v1/usage` |
| 認証 | `Authorization: Bearer <API key>` |
| 応答 | `usage.rolling / weekly / monthly` |
| 数値 | 各枠の `percent` は `usagePercent` をそのまま返す百分率 |
| リセット | `resetsAt` は `Date.now() + resetInSec * 1000` をISO文字列にした値 |
| 状態 | `ok` / `rate-limited` |
| エラー | キー不備401、Go権限なし403 |

[CodexBarの参照実装、コミット 42c7048](https://github.com/steipete/CodexBar/blob/42c7048c9fb117b6ca8ee6d8c8acd7eda0985621/Sources/CodexBarCore/Providers/OpenCodeGo/OpenCodeGoUsageFetcher.swift)と[共通解析処理](https://github.com/steipete/CodexBar/blob/42c7048c9fb117b6ca8ee6d8c8acd7eda0985621/Sources/CodexBarCore/Providers/Shared/OpenCodeWebParsing.swift)で、APIの直接百分率が0〜100であること、相対秒、used/limit形式を確認しました。今回の実装では限定した別名のみ対応し、欠落を0にする処理、異常値のクランプ、値が1以下なら100倍する処理を採用していません。

公式ソースには中継された応答を返す経路もあるため、公開ソースで見えた形式と実際の応答が常に同一とは断定しません。ユーザーのAPIキーでの取得は未実施です。

### Scriptable

[ListWidget](https://docs.scriptable.app/listwidget/)、[WidgetStack](https://docs.scriptable.app/widgetstack/)、[Request](https://docs.scriptable.app/request/)、[Keychain](https://docs.scriptable.app/keychain/)、[Alert](https://docs.scriptable.app/alert/)の公式資料を確認しました。実行時の外部ライブラリ読込みはありません。15分更新は要求であり保証ではありません。10秒のtimeoutIntervalは待機時間を対象にするため、実行全体の制限と同一ではありません。

## 既知の制約

1. **実機表示と実接続は未確認。** 認証をチャットへ提出する必要はありません。導入後にユーザーのiPhoneで確認します。
2. **排他は完全ではない。** 60秒のファイルロック、所有者確認、保存値再読込みで競合を減らしますが、原子的なcompare-and-setはScriptableで保証できません。元ウィジェット停止が必要です。
3. **APIの未知形式は取得不可。** 単位不明の数値リセットや文字列の数値は推測しません。個別枠の欠落で正常な枠は消しませんが、全枠不明なら解析失敗として前回値を使います。
4. **iOSが実行と再描画を制御。** 実行の打切り、更新遅延、手動プレビュー後のホーム画面即時更新を保証できません。
5. **ローカル同時書込みと保存障害。** キャッシュが壊れた場合は無視して再取得します。ストレージ障害で429待機情報が保存できない場合、別実行への待機状態の引継ぎも保証できません。

## ユーザーの受入チェック

1. 元ウィジェット停止後に導入し、Codexの残量が引き継がれる。
2. iPhoneでOpenCode Goキーを入力し、両サービスの実データが同時に表示される。
3. 同時刻帯の管理画面と残量の意味・リセット時刻が一致する。
4. 中サイズの明暗両テーマで全5枠と状態・取得日時が読める。
5. 通信失敗後も前回値と元の正常取得時刻が維持され、通信復旧後の手動取得で最新になる。

未確認項目が解決したら、端末モデル・iOS/Scriptableバージョン・確認日・結果だけを追記します。キー・トークン・API応答全文は記録しません。
